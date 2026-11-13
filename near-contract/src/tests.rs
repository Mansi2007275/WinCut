//! Contract-level tests. These drive the real state machine: deposits, the
//! swap lock, both settlement callbacks and the failure paths. Cross-contract
//! calls cannot execute in a unit-test VM, so each callback is invoked with the
//! promise result Rhea and the token would have produced.

use crate::types::{Hop, LockKind, Side};
use crate::{WinCut, USDC_TOKEN_ID};
use near_sdk::json_types::U128;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, AccountId, Gas, NearToken, PromiseError};

const USDC: u128 = 1_000_000; // 6 decimals
const TOK: u128 = 1_000_000_000_000_000_000; // RHEA has 18

fn wincut() -> AccountId {
    "wincut.near".parse().unwrap()
}
fn owner() -> AccountId {
    "owner.near".parse().unwrap()
}
fn alice() -> AccountId {
    "alice.near".parse().unwrap()
}
fn bob() -> AccountId {
    "bob.near".parse().unwrap()
}
fn carol() -> AccountId {
    "carol.near".parse().unwrap()
}
fn usdc() -> AccountId {
    USDC_TOKEN_ID.parse().unwrap()
}
fn rhea() -> AccountId {
    "v2.ref-finance.near".parse().unwrap()
}
fn token() -> AccountId {
    "token.rhealab.near".parse().unwrap()
}

fn as_user(who: &AccountId, yocto: u128, tgas: u64) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(wincut())
        .predecessor_account_id(who.clone())
        .signer_account_id(who.clone())
        .attached_deposit(NearToken::from_yoctonear(yocto))
        .prepaid_gas(Gas::from_tgas(tgas))
        .block_timestamp(1_700_000_000_000_000_000)
        .build());
}

/// Callbacks run as the contract itself.
fn as_self() {
    as_user(&wincut(), 0, 200);
}

fn hops() -> Vec<Hop> {
    vec![
        Hop {
            pool_id: 4512,
            token_in: usdc(),
            token_out: "wrap.near".parse().unwrap(),
        },
        Hop {
            pool_id: 6458,
            token_in: "wrap.near".parse().unwrap(),
            token_out: token(),
        },
    ]
}

fn setup() -> WinCut {
    as_user(&owner(), 0, 100);
    let mut c = WinCut::new(owner(), Some(usdc()), Some(rhea()));
    c.list_token(
        token(),
        "RHEA".to_string(),
        18,
        hops(),
        "refv1-6458".to_string(),
    );
    // register_token needs two cross-contract calls, so flip the flag directly.
    c.tokens.get_mut(&token()).unwrap().registered = true;
    c
}

fn deposit(c: &mut WinCut, who: &AccountId, amount: u128) {
    as_user(&usdc(), 0, 100);
    let left = c.ft_on_transfer(who.clone(), U128(amount), "deposit".to_string());
    match left {
        near_sdk::PromiseOrValue::Value(v) => {
            assert_eq!(v.0, 0, "the whole deposit should be kept")
        }
        _ => panic!("a deposit should not return a promise"),
    }
}

/// Runs a complete buy: the user's call, the swap result, then the measured
/// token balance Rhea's payout produced.
fn do_buy(
    c: &mut WinCut,
    who: &AccountId,
    usdc_in: u128,
    tokens_out: u128,
    followed: Option<AccountId>,
    referrer: Option<AccountId>,
) {
    as_user(who, 0, 200);
    let _ = c.buy(token(), U128(usdc_in), U128(0), followed, referrer);
    as_self();
    let _ = c.on_buy_swapped(Ok(U128(usdc_in)));
    as_self();
    // The contract now really holds what it held before plus the swap output.
    let measured = c.get_token_accounted(token()).0 + tokens_out;
    c.on_buy_settled(U128(usdc_in), Ok(U128(measured)));
}

/// Runs a complete sell with `proceeds` USDC coming back from Rhea.
fn do_sell(c: &mut WinCut, who: &AccountId, amount: u128, proceeds: u128) {
    as_user(who, 0, 200);
    let _ = c.sell(token(), U128(amount), U128(0));
    as_self();
    let _ = c.on_sell_swapped(Ok(U128(amount)));
    as_self();
    let measured = c.get_usdc_accounted().0 + proceeds;
    c.on_sell_settled(U128(amount), Ok(U128(measured)));
}

// --------------------------------------------------------------- deposits

#[test]
fn a_usdc_deposit_lands_in_the_internal_balance() {
    let mut c = setup();
    deposit(&mut c, &alice(), 500 * USDC);
    assert_eq!(c.get_balance(alice()).0, 500 * USDC);
    assert_eq!(c.get_usdc_accounted().0, 500 * USDC);
}

#[test]
fn a_token_that_is_not_usdc_is_handed_straight_back() {
    let mut c = setup();
    as_user(&token(), 0, 100);
    let left = c.ft_on_transfer(alice(), U128(5 * TOK), "deposit".to_string());
    match left {
        near_sdk::PromiseOrValue::Value(v) => assert_eq!(v.0, 5 * TOK, "it must all be refunded"),
        _ => panic!("expected a value"),
    }
    assert_eq!(c.get_balance(alice()).0, 0);
}

#[test]
fn an_unrecognised_msg_is_refused_rather_than_guessed_at() {
    let mut c = setup();
    as_user(&usdc(), 0, 100);
    let left = c.ft_on_transfer(alice(), U128(10 * USDC), "buy everything".to_string());
    match left {
        near_sdk::PromiseOrValue::Value(v) => assert_eq!(v.0, 10 * USDC),
        _ => panic!("expected a value"),
    }
    assert_eq!(c.get_balance(alice()).0, 0);
}

// ------------------------------------------------------------------- buys

#[test]
fn a_buy_costs_no_wincut_fee_and_opens_a_position() {
    let mut c = setup();
    deposit(&mut c, &alice(), 500 * USDC);
    do_buy(
        &mut c,
        &alice(),
        100 * USDC,
        2500 * TOK,
        Some(bob()),
        Some(carol()),
    );

    assert_eq!(
        c.get_balance(alice()).0,
        400 * USDC,
        "only the amount spent left the balance"
    );
    let p = c.get_position(alice(), token()).unwrap();
    assert_eq!(p.amount.0, 2500 * TOK);
    assert_eq!(
        p.cost_basis_usdc.0,
        100 * USDC,
        "the basis is the full amount spent: no fee"
    );
    assert_eq!(p.followed, Some(bob()));
    assert_eq!(p.referrer, Some(carol()));
    assert_eq!(c.get_claimable(owner()).0, 0, "a buy pays nobody");
    assert_eq!(c.get_token_accounted(token()).0, 2500 * TOK);

    let trades = c.get_recent_trades(None, None);
    assert_eq!(trades.len(), 1);
    assert_eq!(trades[0].side, Side::Buy);
    assert_eq!(trades[0].fee.0, 0);
}

#[test]
fn copying_yourself_or_referring_yourself_is_ignored() {
    let mut c = setup();
    deposit(&mut c, &alice(), 500 * USDC);
    do_buy(
        &mut c,
        &alice(),
        100 * USDC,
        1000 * TOK,
        Some(alice()),
        Some(alice()),
    );

    let p = c.get_position(alice(), token()).unwrap();
    assert_eq!(p.followed, None, "you cannot be your own copied trader");
    assert_eq!(p.referrer, None, "you cannot be your own referrer");

    // With nobody else to pay, the whole fee goes to the protocol.
    do_sell(&mut c, &alice(), 1000 * TOK, 150 * USDC);
    assert_eq!(
        c.get_claimable(alice()).0,
        0,
        "self-referral must not pay the user"
    );
    assert_eq!(c.get_claimable(owner()).0, 5 * USDC);
}

#[test]
fn a_second_buy_averages_into_the_position_without_re_pointing_the_payout() {
    let mut c = setup();
    deposit(&mut c, &alice(), 500 * USDC);
    do_buy(&mut c, &alice(), 100 * USDC, 1000 * TOK, Some(bob()), None);
    // A later buy naming a different trader must not steal bob's attribution.
    do_buy(&mut c, &alice(), 100 * USDC, 500 * TOK, Some(carol()), None);

    let p = c.get_position(alice(), token()).unwrap();
    assert_eq!(p.amount.0, 1500 * TOK);
    assert_eq!(p.cost_basis_usdc.0, 200 * USDC);
    assert_eq!(
        p.followed,
        Some(bob()),
        "the trader is fixed by the opening buy"
    );
}

#[test]
fn a_failed_swap_refunds_the_whole_amount_and_releases_the_lock() {
    let mut c = setup();
    deposit(&mut c, &alice(), 500 * USDC);

    as_user(&alice(), 0, 200);
    let _ = c.buy(token(), U128(100 * USDC), U128(0), Some(bob()), None);
    assert_eq!(
        c.get_balance(alice()).0,
        400 * USDC,
        "the spend is held while in flight"
    );
    assert!(c.get_config().swap_in_flight);

    as_self();
    let _ = c.on_buy_swapped(Err(PromiseError::Failed));

    assert_eq!(
        c.get_balance(alice()).0,
        500 * USDC,
        "every cent comes back"
    );
    assert!(
        !c.get_config().swap_in_flight,
        "the lock must not survive a failure"
    );
    assert!(
        c.get_position(alice(), token()).is_none(),
        "no position was opened"
    );
    assert_eq!(
        c.get_recent_trades(None, None).len(),
        0,
        "a failed buy is not a trade"
    );
}

#[test]
fn a_partially_filled_swap_refunds_the_unspent_remainder() {
    let mut c = setup();
    deposit(&mut c, &alice(), 500 * USDC);

    as_user(&alice(), 0, 200);
    let _ = c.buy(token(), U128(100 * USDC), U128(0), None, None);
    as_self();
    let _ = c.on_buy_swapped(Ok(U128(60 * USDC))); // Rhea only consumed $60
    as_self();
    c.on_buy_settled(U128(60 * USDC), Ok(U128(600 * TOK)));

    assert_eq!(
        c.get_balance(alice()).0,
        440 * USDC,
        "the unspent $40 is returned"
    );
    let p = c.get_position(alice(), token()).unwrap();
    assert_eq!(
        p.cost_basis_usdc.0,
        60 * USDC,
        "the basis is what was actually spent"
    );
}

#[test]
fn a_swap_whose_output_never_arrives_refunds_the_user_and_records_the_gap() {
    let mut c = setup();
    deposit(&mut c, &alice(), 500 * USDC);

    as_user(&alice(), 0, 200);
    let _ = c.buy(token(), U128(100 * USDC), U128(0), None, None);
    as_self();
    let _ = c.on_buy_swapped(Ok(U128(100 * USDC)));
    as_self();
    // Rhea said it filled, but the measured balance did not move.
    c.on_buy_settled(U128(100 * USDC), Ok(U128(0)));

    assert_eq!(
        c.get_balance(alice()).0,
        500 * USDC,
        "the user is made whole immediately"
    );
    assert_eq!(
        c.get_config().shortfall_usdc.0,
        100 * USDC,
        "and the gap is on the record"
    );
    assert!(c.get_position(alice(), token()).is_none());
    assert!(!c.get_config().swap_in_flight);
}

#[test]
#[should_panic(expected = "another settlement is in flight")]
fn a_second_trade_cannot_start_while_one_is_settling() {
    let mut c = setup();
    deposit(&mut c, &alice(), 500 * USDC);
    as_user(&alice(), 0, 200);
    let _ = c.buy(token(), U128(100 * USDC), U128(0), None, None);
    as_user(&bob(), 0, 200);
    let _ = c.buy(token(), U128(USDC), U128(0), None, None);
}

#[test]
#[should_panic(expected = "not enough USDC")]
fn you_cannot_spend_what_you_have_not_deposited() {
    let mut c = setup();
    deposit(&mut c, &alice(), 10 * USDC);
    as_user(&alice(), 0, 200);
    let _ = c.buy(token(), U128(11 * USDC), U128(0), None, None);
}

#[test]
#[should_panic(expected = "attach at least 170 Tgas")]
fn a_trade_without_enough_gas_is_refused_before_any_money_moves() {
    let mut c = setup();
    deposit(&mut c, &alice(), 100 * USDC);
    as_user(&alice(), 0, 30);
    let _ = c.buy(token(), U128(10 * USDC), U128(0), None, None);
}

#[test]
#[should_panic(expected = "not listed on WinCut")]
fn an_unlisted_token_cannot_be_bought() {
    let mut c = setup();
    deposit(&mut c, &alice(), 100 * USDC);
    as_user(&alice(), 0, 200);
    let _ = c.buy(
        "random.tkn.near".parse().unwrap(),
        U128(10 * USDC),
        U128(0),
        None,
        None,
    );
}

// ------------------------------------------------------------------ sells

#[test]
fn selling_at_a_profit_charges_ten_percent_and_splits_it_three_ways() {
    let mut c = setup();
    deposit(&mut c, &alice(), 500 * USDC);
    do_buy(
        &mut c,
        &alice(),
        100 * USDC,
        1000 * TOK,
        Some(bob()),
        Some(carol()),
    );
    do_sell(&mut c, &alice(), 1000 * TOK, 150 * USDC);

    // $50 profit, $5 fee, $145 back to the user.
    assert_eq!(c.get_balance(alice()).0, 400 * USDC + 145 * USDC);
    assert_eq!(c.get_claimable(bob()).0, 2_500_000, "50% of the fee");
    assert_eq!(c.get_claimable(carol()).0, 1_000_000, "20% of the fee");
    assert_eq!(c.get_claimable(owner()).0, 1_500_000, "30% of the fee");
    assert_eq!(c.get_loss_credit(alice()).0, 0);
    assert!(
        c.get_position(alice(), token()).is_none(),
        "the position closed"
    );

    let trader = c.get_trader(bob());
    assert_eq!(trader.earnings_usdc.0, 2_500_000);
    assert_eq!(trader.followers, 1);

    let me = c.get_trader(alice());
    assert!(!me.realised_pnl.negative);
    assert_eq!(me.realised_pnl.abs.0, 50 * USDC);
    assert_eq!(me.wins, 1);
}

#[test]
fn selling_at_a_loss_is_free_and_banks_the_loss_as_credit() {
    let mut c = setup();
    deposit(&mut c, &alice(), 500 * USDC);
    do_buy(
        &mut c,
        &alice(),
        100 * USDC,
        1000 * TOK,
        Some(bob()),
        Some(carol()),
    );
    do_sell(&mut c, &alice(), 1000 * TOK, 80 * USDC);

    assert_eq!(
        c.get_balance(alice()).0,
        400 * USDC + 80 * USDC,
        "all $80 goes to the user"
    );
    assert_eq!(c.get_claimable(bob()).0, 0, "nobody earns on a loss");
    assert_eq!(c.get_claimable(carol()).0, 0);
    assert_eq!(c.get_claimable(owner()).0, 0);
    assert_eq!(
        c.get_loss_credit(alice()).0,
        20 * USDC,
        "the $20 loss is banked"
    );

    let t = &c.get_recent_trades(None, None)[0];
    assert_eq!(t.fee.0, 0);
    let pnl = t.pnl.unwrap();
    assert!(pnl.negative);
    assert_eq!(pnl.abs.0, 20 * USDC);

    let me = c.get_trader(alice());
    assert!(me.realised_pnl.negative);
    assert_eq!(me.realised_pnl.abs.0, 20 * USDC);
    assert_eq!(me.losses, 1);
}

#[test]
fn a_banked_loss_cuts_the_fee_on_the_next_win() {
    let mut c = setup();
    deposit(&mut c, &alice(), 1000 * USDC);

    // Lose $20 and bank it.
    do_buy(
        &mut c,
        &alice(),
        100 * USDC,
        1000 * TOK,
        Some(bob()),
        Some(carol()),
    );
    do_sell(&mut c, &alice(), 1000 * TOK, 80 * USDC);
    assert_eq!(c.get_loss_credit(alice()).0, 20 * USDC);

    // Then make $50. Only $30 of it is taxable, so the fee is $3, not $5.
    do_buy(
        &mut c,
        &alice(),
        100 * USDC,
        1000 * TOK,
        Some(bob()),
        Some(carol()),
    );
    do_sell(&mut c, &alice(), 1000 * TOK, 150 * USDC);

    assert_eq!(c.get_loss_credit(alice()).0, 0, "the credit was spent");
    let fee: u128 =
        c.get_claimable(bob()).0 + c.get_claimable(carol()).0 + c.get_claimable(owner()).0;
    assert_eq!(fee, 3 * USDC);
    assert_eq!(c.get_claimable(bob()).0, 1_500_000);
    assert_eq!(c.get_claimable(carol()).0, 600_000);
    assert_eq!(c.get_claimable(owner()).0, 900_000);

    let me = c.get_trader(alice());
    assert!(!me.realised_pnl.negative);
    assert_eq!(
        me.realised_pnl.abs.0,
        30 * USDC,
        "-20 then +50 across two trades"
    );
}

#[test]
fn a_partial_sell_leaves_a_proportional_basis_behind() {
    let mut c = setup();
    deposit(&mut c, &alice(), 500 * USDC);
    do_buy(&mut c, &alice(), 100 * USDC, 1000 * TOK, None, None);
    do_sell(&mut c, &alice(), 400 * TOK, 60 * USDC);

    let p = c.get_position(alice(), token()).unwrap();
    assert_eq!(p.amount.0, 600 * TOK);
    assert_eq!(
        p.cost_basis_usdc.0,
        60 * USDC,
        "40% of the $100 basis went with the sale"
    );
    // $40 of basis sold for $60, so $20 profit and a $2 fee.
    assert_eq!(c.get_claimable(owner()).0, 2 * USDC);
    assert_eq!(c.get_balance(alice()).0, 400 * USDC + 58 * USDC);
    assert_eq!(c.get_token_accounted(token()).0, 600 * TOK);
}

#[test]
fn quote_sell_fee_promises_exactly_what_the_sell_charges() {
    let mut c = setup();
    deposit(&mut c, &alice(), 500 * USDC);
    do_buy(
        &mut c,
        &alice(),
        100 * USDC,
        1000 * TOK,
        Some(bob()),
        Some(carol()),
    );

    let quote = c.quote_sell_fee(alice(), token(), U128(1000 * TOK), U128(150 * USDC));
    assert_eq!(quote.fee.0, 5 * USDC);
    assert_eq!(quote.user_receives.0, 145 * USDC);
    assert_eq!(quote.to_trader.0, 2_500_000);

    do_sell(&mut c, &alice(), 1000 * TOK, 150 * USDC);
    let charged =
        c.get_claimable(bob()).0 + c.get_claimable(carol()).0 + c.get_claimable(owner()).0;
    assert_eq!(
        charged, quote.fee.0,
        "the quote is the same pure function the sell runs"
    );
}

#[test]
fn quoting_a_loss_shows_a_zero_fee_and_the_credit_it_would_bank() {
    let mut c = setup();
    deposit(&mut c, &alice(), 500 * USDC);
    do_buy(&mut c, &alice(), 100 * USDC, 1000 * TOK, None, None);

    let quote = c.quote_sell_fee(alice(), token(), U128(1000 * TOK), U128(80 * USDC));
    assert_eq!(quote.fee.0, 0);
    assert!(quote.pnl.negative);
    assert_eq!(quote.credit_banked.0, 20 * USDC);
    assert_eq!(quote.loss_credit_after.0, 20 * USDC);
}

#[test]
fn a_sell_whose_swap_bounces_leaves_the_position_exactly_as_it_was() {
    let mut c = setup();
    deposit(&mut c, &alice(), 500 * USDC);
    do_buy(&mut c, &alice(), 100 * USDC, 1000 * TOK, Some(bob()), None);

    as_user(&alice(), 0, 200);
    let _ = c.sell(token(), U128(1000 * TOK), U128(999 * USDC));
    as_self();
    let _ = c.on_sell_swapped(Err(PromiseError::Failed));

    let p = c.get_position(alice(), token()).unwrap();
    assert_eq!(p.amount.0, 1000 * TOK, "the tokens came back");
    assert_eq!(p.cost_basis_usdc.0, 100 * USDC);
    assert_eq!(c.get_token_accounted(token()).0, 1000 * TOK);
    assert_eq!(
        c.get_loss_credit(alice()).0,
        0,
        "a bounced sell is not a loss"
    );
    assert!(!c.get_config().swap_in_flight);
}

#[test]
fn a_sell_that_cannot_be_measured_is_abandoned_without_charging_anything() {
    let mut c = setup();
    deposit(&mut c, &alice(), 500 * USDC);
    do_buy(&mut c, &alice(), 100 * USDC, 1000 * TOK, None, None);

    as_user(&alice(), 0, 200);
    let _ = c.sell(token(), U128(1000 * TOK), U128(0));
    as_self();
    let _ = c.on_sell_swapped(Ok(U128(1000 * TOK)));
    as_self();
    c.on_sell_settled(U128(1000 * TOK), Err(PromiseError::Failed));

    assert_eq!(
        c.get_position(alice(), token()).unwrap().amount.0,
        1000 * TOK
    );
    assert_eq!(c.get_claimable(owner()).0, 0);
    assert!(!c.get_config().swap_in_flight);
}

#[test]
#[should_panic(expected = "you do not hold that much")]
fn you_cannot_sell_more_than_you_hold() {
    let mut c = setup();
    deposit(&mut c, &alice(), 500 * USDC);
    do_buy(&mut c, &alice(), 100 * USDC, 1000 * TOK, None, None);
    as_user(&alice(), 0, 200);
    let _ = c.sell(token(), U128(1001 * TOK), U128(0));
}

// ------------------------------------------------- withdrawals and claims

#[test]
fn a_withdrawal_debits_now_and_is_confirmed_by_its_callback() {
    let mut c = setup();
    deposit(&mut c, &alice(), 500 * USDC);

    as_user(&alice(), 1, 100);
    let _ = c.withdraw(U128(200 * USDC));
    assert_eq!(c.get_balance(alice()).0, 300 * USDC);
    assert!(
        c.get_config().swap_in_flight,
        "an outflow holds the lock too"
    );

    as_self();
    assert!(c.on_payout_settled(alice(), U128(200 * USDC), false, Ok(())));
    assert_eq!(c.get_balance(alice()).0, 300 * USDC);
    assert!(!c.get_config().swap_in_flight);
}

#[test]
fn a_bounced_withdrawal_puts_the_usdc_back() {
    let mut c = setup();
    deposit(&mut c, &alice(), 500 * USDC);

    as_user(&alice(), 1, 100);
    let _ = c.withdraw(U128(200 * USDC));
    as_self();
    assert!(!c.on_payout_settled(alice(), U128(200 * USDC), false, Err(PromiseError::Failed)));
    assert_eq!(c.get_balance(alice()).0, 500 * USDC, "restored in full");
    assert_eq!(c.get_usdc_accounted().0, 500 * USDC);
}

#[test]
fn a_trader_claims_the_fee_share_they_earned() {
    let mut c = setup();
    deposit(&mut c, &alice(), 500 * USDC);
    do_buy(
        &mut c,
        &alice(),
        100 * USDC,
        1000 * TOK,
        Some(bob()),
        Some(carol()),
    );
    do_sell(&mut c, &alice(), 1000 * TOK, 150 * USDC);
    assert_eq!(c.get_claimable(bob()).0, 2_500_000);

    as_user(&bob(), 1, 100);
    let _ = c.claim();
    assert_eq!(c.get_claimable(bob()).0, 0);
    as_self();
    assert!(c.on_payout_settled(bob(), U128(2_500_000), true, Ok(())));
    assert!(!c.get_config().swap_in_flight);
}

#[test]
fn a_bounced_claim_restores_the_entitlement() {
    let mut c = setup();
    deposit(&mut c, &alice(), 500 * USDC);
    do_buy(&mut c, &alice(), 100 * USDC, 1000 * TOK, Some(bob()), None);
    do_sell(&mut c, &alice(), 1000 * TOK, 150 * USDC);
    let earned = c.get_claimable(bob()).0;

    as_user(&bob(), 1, 100);
    let _ = c.claim();
    as_self();
    c.on_payout_settled(bob(), U128(earned), true, Err(PromiseError::Failed));
    assert_eq!(c.get_claimable(bob()).0, earned, "still owed");
}

#[test]
#[should_panic(expected = "nothing to claim")]
fn claiming_nothing_is_an_error_rather_than_an_empty_transfer() {
    let mut c = setup();
    as_user(&bob(), 1, 100);
    let _ = c.claim();
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn a_withdrawal_needs_the_one_yocto_that_forces_a_wallet_signature() {
    let mut c = setup();
    deposit(&mut c, &alice(), 100 * USDC);
    as_user(&alice(), 0, 100);
    let _ = c.withdraw(U128(USDC));
}

// -------------------------------------------------------- the trade ledger

#[test]
fn the_usdc_ledger_always_adds_up_to_what_the_contract_holds() {
    let mut c = setup();
    deposit(&mut c, &alice(), 500 * USDC);
    do_buy(
        &mut c,
        &alice(),
        100 * USDC,
        1000 * TOK,
        Some(bob()),
        Some(carol()),
    );
    do_sell(&mut c, &alice(), 1000 * TOK, 150 * USDC);

    // $500 in, $100 out to Rhea, $150 back: the contract should hold $550, and
    // every cent of it is owed to somebody.
    let owed = c.get_balance(alice()).0
        + c.get_claimable(bob()).0
        + c.get_claimable(carol()).0
        + c.get_claimable(owner()).0;
    assert_eq!(owed, 550 * USDC);
    assert_eq!(c.get_usdc_accounted().0, owed, "no USDC is unaccounted for");
}

#[test]
fn the_trade_feed_returns_the_newest_first() {
    let mut c = setup();
    deposit(&mut c, &alice(), 1000 * USDC);
    do_buy(&mut c, &alice(), 100 * USDC, 1000 * TOK, None, None);
    do_sell(&mut c, &alice(), 500 * TOK, 60 * USDC);
    do_sell(&mut c, &alice(), 500 * TOK, 60 * USDC);

    let trades = c.get_recent_trades(None, None);
    assert_eq!(trades.len(), 3);
    assert_eq!(trades[0].id, 2, "newest first");
    assert_eq!(trades[1].id, 1);
    assert_eq!(trades[2].id, 0);
    assert_eq!(trades[0].side, Side::Sell);

    let page = c.get_recent_trades(Some(1), Some(1));
    assert_eq!(page.len(), 1);
    assert_eq!(page[0].id, 1, "from skips from the newest end");

    assert_eq!(c.get_trades_of(alice(), None).len(), 3);
    assert_eq!(c.get_trades_of(bob(), None).len(), 0);
}

#[test]
fn the_copy_feed_only_shows_trades_that_credit_that_trader() {
    let mut c = setup();
    deposit(&mut c, &alice(), 1000 * USDC);
    do_buy(&mut c, &alice(), 100 * USDC, 1000 * TOK, Some(bob()), None);
    do_sell(&mut c, &alice(), 1000 * TOK, 150 * USDC);

    assert_eq!(c.get_copy_feed(bob(), None).len(), 2);
    assert_eq!(c.get_copy_feed(carol(), None).len(), 0);
}

#[test]
fn the_leaderboard_puts_profit_above_loss() {
    let mut c = setup();
    deposit(&mut c, &alice(), 1000 * USDC);
    deposit(&mut c, &bob(), 1000 * USDC);

    do_buy(&mut c, &alice(), 100 * USDC, 1000 * TOK, None, None);
    do_sell(&mut c, &alice(), 1000 * TOK, 150 * USDC); // +$50
    do_buy(&mut c, &bob(), 100 * USDC, 1000 * TOK, None, None);
    do_sell(&mut c, &bob(), 1000 * TOK, 70 * USDC); // -$30

    let board = c.get_leaderboard(Some(10));
    assert_eq!(board[0].account_id, alice());
    assert_eq!(board[0].realised_pnl.abs.0, 50 * USDC);
    assert!(!board[0].realised_pnl.negative);
    assert_eq!(board[1].account_id, bob());
    assert!(board[1].realised_pnl.negative);
}

#[test]
fn positions_can_be_listed_for_a_user() {
    let mut c = setup();
    deposit(&mut c, &alice(), 1000 * USDC);
    do_buy(&mut c, &alice(), 100 * USDC, 1000 * TOK, Some(bob()), None);

    let positions = c.get_positions(alice());
    assert_eq!(positions.len(), 1);
    assert_eq!(positions[0].symbol, "RHEA");
    assert_eq!(positions[0].decimals, 18);
    assert_eq!(positions[0].amount.0, 1000 * TOK);

    do_sell(&mut c, &alice(), 1000 * TOK, 150 * USDC);
    assert_eq!(
        c.get_positions(alice()).len(),
        0,
        "a closed position drops off the list"
    );
}

// --------------------------------------------------------------- the lock

#[test]
fn a_stale_lock_can_be_cleared_by_anyone_once_it_has_timed_out() {
    let mut c = setup();
    deposit(&mut c, &alice(), 500 * USDC);
    as_user(&alice(), 0, 200);
    let _ = c.buy(token(), U128(100 * USDC), U128(0), None, None);
    assert!(c.get_config().swap_in_flight);

    // Six minutes later, with no callback ever having arrived.
    testing_env!(VMContextBuilder::new()
        .current_account_id(wincut())
        .predecessor_account_id(carol())
        .block_timestamp(1_700_000_000_000_000_000 + 360 * 1_000_000_000)
        .prepaid_gas(Gas::from_tgas(100))
        .build());
    assert!(c.release_stale_lock());
    assert!(!c.get_config().swap_in_flight);
}

#[test]
#[should_panic(expected = "the lock is still fresh")]
fn a_fresh_lock_cannot_be_cleared() {
    let mut c = setup();
    deposit(&mut c, &alice(), 500 * USDC);
    as_user(&alice(), 0, 200);
    let _ = c.buy(token(), U128(100 * USDC), U128(0), None, None);
    as_user(&carol(), 0, 100);
    c.release_stale_lock();
}

#[test]
fn the_configured_split_is_the_one_the_maths_uses() {
    let c = setup();
    let cfg = c.get_config();
    assert_eq!(cfg.fee_bps_of_profit, 1000, "10% of profit");
    assert_eq!(cfg.trader_share_pct, 50);
    assert_eq!(cfg.referrer_share_pct, 20);
    assert_eq!(cfg.protocol_share_pct, 30);
    assert_eq!(cfg.usdc_id.to_string(), USDC_TOKEN_ID);
}

#[test]
#[should_panic(expected = "owner only")]
fn only_the_owner_can_list_a_token() {
    let mut c = setup();
    as_user(&alice(), 0, 100);
    c.list_token(
        "x.tkn.near".parse().unwrap(),
        "X".to_string(),
        18,
        hops(),
        "p".to_string(),
    );
}

#[test]
#[should_panic(expected = "the first hop must spend USDC")]
fn a_route_that_does_not_start_from_usdc_is_rejected() {
    let mut c = setup();
    as_user(&owner(), 0, 100);
    let bad = vec![Hop {
        pool_id: 1,
        token_in: "wrap.near".parse().unwrap(),
        token_out: token(),
    }];
    c.list_token(token(), "RHEA".to_string(), 18, bad, "p".to_string());
}

#[test]
#[should_panic(expected = "the hops do not join up")]
fn a_route_with_a_gap_in_it_is_rejected() {
    let mut c = setup();
    as_user(&owner(), 0, 100);
    let bad = vec![
        Hop {
            pool_id: 4512,
            token_in: usdc(),
            token_out: "wrap.near".parse().unwrap(),
        },
        Hop {
            pool_id: 9,
            token_in: "other.near".parse().unwrap(),
            token_out: token(),
        },
    ];
    c.list_token(token(), "RHEA".to_string(), 18, bad, "p".to_string());
}

#[test]
fn a_paused_contract_refuses_deposits_and_trades() {
    let mut c = setup();
    deposit(&mut c, &alice(), 500 * USDC);
    as_user(&owner(), 0, 100);
    c.set_paused(true);

    as_user(&usdc(), 0, 100);
    match c.ft_on_transfer(alice(), U128(10 * USDC), "deposit".to_string()) {
        near_sdk::PromiseOrValue::Value(v) => assert_eq!(v.0, 10 * USDC, "deposits bounce"),
        _ => panic!("expected a value"),
    }
    assert_eq!(c.get_balance(alice()).0, 500 * USDC);
}

#[test]
fn the_lock_kind_is_reported_distinctly_for_payouts_and_swaps() {
    let mut c = setup();
    deposit(&mut c, &alice(), 500 * USDC);
    as_user(&alice(), 1, 100);
    let _ = c.withdraw(U128(10 * USDC));
    assert_eq!(c.lock.as_ref().unwrap().kind, LockKind::Payout);
    as_self();
    c.on_payout_settled(alice(), U128(10 * USDC), false, Ok(()));

    as_user(&alice(), 0, 200);
    let _ = c.buy(token(), U128(10 * USDC), U128(0), None, None);
    assert_eq!(c.lock.as_ref().unwrap().kind, LockKind::Buy);
}

// ------------------------------------------------- bridged (1Click) deposits

#[test]
fn a_bridged_deposit_credits_the_named_beneficiary_not_the_relayer() {
    // A NEAR Intents 1Click swap settles from a solver account, so without
    // `deposit_for` the user's bridged USDC would land in the solver's balance.
    let mut c = setup();
    let solver: AccountId = "intents-solver.near".parse().unwrap();

    as_user(&usdc(), 0, 100);
    let left = c.ft_on_transfer(
        solver.clone(),
        U128(250 * USDC),
        r#"{"deposit_for":"alice.near"}"#.to_string(),
    );
    match left {
        near_sdk::PromiseOrValue::Value(v) => assert_eq!(v.0, 0, "the deposit is accepted"),
        _ => panic!("expected a value"),
    }

    assert_eq!(c.get_balance(alice()).0, 250 * USDC, "credited to the named account");
    assert_eq!(c.get_balance(solver).0, 0, "and not to the relayer");
    assert_eq!(c.get_usdc_accounted().0, 250 * USDC);
}

#[test]
fn a_bridged_deposit_can_be_spent_like_any_other() {
    let mut c = setup();
    as_user(&usdc(), 0, 100);
    let _ = c.ft_on_transfer(
        "intents-solver.near".parse().unwrap(),
        U128(500 * USDC),
        r#"{"deposit_for":"alice.near"}"#.to_string(),
    );
    do_buy(&mut c, &alice(), 100 * USDC, 1000 * TOK, None, None);
    assert_eq!(c.get_position(alice(), token()).unwrap().cost_basis_usdc.0, 100 * USDC);
}

#[test]
fn a_malformed_deposit_msg_is_refunded_rather_than_credited_to_a_guess() {
    let mut c = setup();
    for msg in [
        r#"{"deposit_for":"NOT A VALID ACCOUNT"}"#,
        r#"{"deposit_for":"alice.near","extra":1}"#,
        r#"{"depositFor":"alice.near"}"#,
        "deposit_for alice.near",
        "{}",
    ] {
        as_user(&usdc(), 0, 100);
        let left = c.ft_on_transfer(bob(), U128(10 * USDC), msg.to_string());
        match left {
            near_sdk::PromiseOrValue::Value(v) => {
                assert_eq!(v.0, 10 * USDC, "msg {msg} should be refunded in full")
            }
            _ => panic!("expected a value"),
        }
    }
    assert_eq!(c.get_balance(alice()).0, 0);
    assert_eq!(c.get_balance(bob()).0, 0);
    assert_eq!(c.get_usdc_accounted().0, 0, "nothing was credited anywhere");
}
