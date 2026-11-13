//! Pure settlement maths. No contract state, no floats, every intermediate in
//! u256 so a 24-decimal token amount times a USDC cost basis cannot overflow.

use crate::types::{I128JsonCmp, SellOutcome};
use near_sdk::json_types::U128;
use primitive_types::U256;

/// WinCut takes 10% of profit. Buys and losing sells are free.
pub const FEE_NUMERATOR: u128 = 10;
pub const FEE_DENOMINATOR: u128 = 100;

/// Split of the fee. The protocol takes the remainder, so the three shares
/// always add back up to exactly `fee` with no dust left over.
pub const TRADER_SHARE_PCT: u128 = 50;
pub const REFERRER_SHARE_PCT: u128 = 20;

/// `a * b / c`, computed in 256 bits and rounded down.
///
/// `cost_basis * sell_amount` overflows u128 for any 24-decimal token
/// (1e12 USDC units x 1e30 token units = 1e42, and u128 tops out near 3.4e38),
/// so the widening is not optional.
pub fn mul_div(a: u128, b: u128, c: u128) -> u128 {
    assert!(c != 0, "mul_div by zero");
    let r = U256::from(a) * U256::from(b) / U256::from(c);
    debug_assert!(r <= U256::from(u128::MAX), "mul_div overflow");
    r.as_u128()
}

/// Everything `sell` is going to do, derived from numbers only.
///
/// * `position_amount` - token units the user holds before the sale
/// * `cost_basis` - USDC units the whole position cost
/// * `sell_amount` - token units being sold
/// * `proceeds` - USDC units Rhea actually returned
/// * `loss_credit` - USDC units of banked loss the user holds
///
/// Rules, in order:
/// 1. `basis_part = cost_basis * sell_amount / position_amount`
/// 2. `pnl = proceeds - basis_part`
/// 3. loss -> fee is 0 and the whole loss is banked as credit
/// 4. profit -> credit is consumed first, then 10% of what is left
/// 5. the fee splits 50 trader / 20 referrer / 30 protocol, and an absent
///    trader or referrer hands their share to the protocol
pub fn settle_sell(
    position_amount: u128,
    cost_basis: u128,
    sell_amount: u128,
    proceeds: u128,
    loss_credit: u128,
    has_trader: bool,
    has_referrer: bool,
) -> SellOutcome {
    assert!(sell_amount > 0, "sell amount is zero");
    assert!(position_amount >= sell_amount, "selling more than held");

    let basis_part = if sell_amount == position_amount {
        // Closing the position exactly: spend the remaining basis to the last
        // unit so repeated partial sells cannot leave basis dust behind.
        cost_basis
    } else {
        mul_div(cost_basis, sell_amount, position_amount)
    };

    if proceeds < basis_part {
        // A loss. No fee, and the loss is banked for later.
        let loss = basis_part - proceeds;
        return SellOutcome {
            basis_part: U128(basis_part),
            pnl: I128JsonCmp {
                negative: true,
                abs: U128(loss),
            },
            loss_credit_before: U128(loss_credit),
            credit_used: U128(0),
            credit_banked: U128(loss),
            loss_credit_after: U128(loss_credit.saturating_add(loss)),
            taxable_profit: U128(0),
            fee: U128(0),
            to_trader: U128(0),
            to_referrer: U128(0),
            to_protocol: U128(0),
            user_receives: U128(proceeds),
        };
    }

    // A profit, or exactly break-even, where every number below is zero.
    let profit = proceeds - basis_part;
    let credit_used = loss_credit.min(profit);
    let taxable = profit - credit_used;
    let fee = mul_div(taxable, FEE_NUMERATOR, FEE_DENOMINATOR);

    let to_trader = if has_trader {
        fee * TRADER_SHARE_PCT / 100
    } else {
        0
    };
    let to_referrer = if has_referrer {
        fee * REFERRER_SHARE_PCT / 100
    } else {
        0
    };
    // Rounding dust and any unclaimed share both fall to the protocol.
    let to_protocol = fee - to_trader - to_referrer;

    SellOutcome {
        basis_part: U128(basis_part),
        pnl: I128JsonCmp {
            negative: false,
            abs: U128(profit),
        },
        loss_credit_before: U128(loss_credit),
        credit_used: U128(credit_used),
        credit_banked: U128(0),
        loss_credit_after: U128(loss_credit - credit_used),
        taxable_profit: U128(taxable),
        fee: U128(fee),
        to_trader: U128(to_trader),
        to_referrer: U128(to_referrer),
        to_protocol: U128(to_protocol),
        user_receives: U128(proceeds - fee),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const USDC: u128 = 1_000_000; // 6 decimals
    const TOK: u128 = 1_000_000_000_000_000_000_000_000; // 24 decimals

    #[test]
    fn profitable_sell_charges_ten_percent_of_profit() {
        // $100 in, $150 out, so $50 profit, a $5 fee and $145 back to the user.
        let o = settle_sell(10 * TOK, 100 * USDC, 10 * TOK, 150 * USDC, 0, true, true);
        assert_eq!(o.basis_part.0, 100 * USDC);
        assert!(!o.pnl.negative);
        assert_eq!(o.pnl.abs.0, 50 * USDC);
        assert_eq!(o.fee.0, 5 * USDC);
        assert_eq!(o.user_receives.0, 145 * USDC);
        assert_eq!(o.to_trader.0, 2_500_000); // $2.50
        assert_eq!(o.to_referrer.0, 1_000_000); // $1.00
        assert_eq!(o.to_protocol.0, 1_500_000); // $1.50
        assert_eq!(o.to_trader.0 + o.to_referrer.0 + o.to_protocol.0, o.fee.0);
    }

    #[test]
    fn losing_sell_is_free_and_banks_the_loss() {
        // $100 in, $80 out, so a $20 loss, no fee and $20 of credit banked.
        let o = settle_sell(10 * TOK, 100 * USDC, 10 * TOK, 80 * USDC, 0, true, true);
        assert!(o.pnl.negative);
        assert_eq!(o.pnl.abs.0, 20 * USDC);
        assert_eq!(o.fee.0, 0, "a loss must never be charged");
        assert_eq!(o.credit_banked.0, 20 * USDC);
        assert_eq!(o.loss_credit_after.0, 20 * USDC);
        assert_eq!(
            o.user_receives.0,
            80 * USDC,
            "the user keeps every cent of the proceeds"
        );
    }

    #[test]
    fn banked_credit_is_consumed_before_any_fee() {
        // Holding $20 of credit, a $50 profit is taxed on $30 only, so $3.
        let o = settle_sell(
            10 * TOK,
            100 * USDC,
            10 * TOK,
            150 * USDC,
            20 * USDC,
            true,
            true,
        );
        assert_eq!(o.credit_used.0, 20 * USDC);
        assert_eq!(o.taxable_profit.0, 30 * USDC);
        assert_eq!(o.fee.0, 3 * USDC);
        assert_eq!(o.loss_credit_after.0, 0);
        assert_eq!(o.user_receives.0, 147 * USDC);
    }

    #[test]
    fn credit_larger_than_profit_wipes_the_fee_and_keeps_the_rest() {
        // $80 of credit against a $50 profit: no fee, and $30 of credit survives.
        let o = settle_sell(
            10 * TOK,
            100 * USDC,
            10 * TOK,
            150 * USDC,
            80 * USDC,
            true,
            true,
        );
        assert_eq!(o.credit_used.0, 50 * USDC);
        assert_eq!(o.taxable_profit.0, 0);
        assert_eq!(o.fee.0, 0);
        assert_eq!(o.loss_credit_after.0, 30 * USDC);
        assert_eq!(o.user_receives.0, 150 * USDC);
    }

    #[test]
    fn loss_then_win_is_the_demo_path() {
        // Lose $20, bank it, then make $50 on the next trade: the fee is $3, not $5.
        let lose = settle_sell(10 * TOK, 100 * USDC, 10 * TOK, 80 * USDC, 0, false, false);
        let win = settle_sell(
            5 * TOK,
            100 * USDC,
            5 * TOK,
            150 * USDC,
            lose.loss_credit_after.0,
            false,
            false,
        );
        assert_eq!(lose.fee.0, 0);
        assert_eq!(win.fee.0, 3 * USDC);
        assert_eq!(win.loss_credit_after.0, 0);
    }

    #[test]
    fn missing_trader_and_referrer_shares_go_to_the_protocol() {
        let o = settle_sell(10 * TOK, 100 * USDC, 10 * TOK, 150 * USDC, 0, false, false);
        assert_eq!(o.to_trader.0, 0);
        assert_eq!(o.to_referrer.0, 0);
        assert_eq!(o.to_protocol.0, o.fee.0);
        assert_eq!(o.to_protocol.0, 5 * USDC);

        let only_trader = settle_sell(10 * TOK, 100 * USDC, 10 * TOK, 150 * USDC, 0, true, false);
        assert_eq!(only_trader.to_trader.0, 2_500_000);
        assert_eq!(only_trader.to_referrer.0, 0);
        assert_eq!(
            only_trader.to_protocol.0, 2_500_000,
            "the referrer 20% falls to the protocol"
        );
    }

    #[test]
    fn partial_sell_takes_a_proportional_slice_of_the_basis() {
        // Sell 3 of 10 tokens that cost $100: $30 of basis, $15 profit on $45 out.
        let o = settle_sell(10 * TOK, 100 * USDC, 3 * TOK, 45 * USDC, 0, true, true);
        assert_eq!(o.basis_part.0, 30 * USDC);
        assert_eq!(o.pnl.abs.0, 15 * USDC);
        assert_eq!(o.fee.0, 1_500_000);
    }

    #[test]
    fn closing_the_position_spends_the_basis_exactly() {
        // A basis that does not divide evenly must not leave dust on a full close.
        let basis = 100_000_001u128;
        let o = settle_sell(3 * TOK, basis, 3 * TOK, basis + 7, 0, false, false);
        assert_eq!(o.basis_part.0, basis);
        assert_eq!(o.pnl.abs.0, 7);
    }

    #[test]
    fn break_even_sell_is_free() {
        let o = settle_sell(TOK, 100 * USDC, TOK, 100 * USDC, 0, true, true);
        assert!(!o.pnl.negative);
        assert_eq!(o.pnl.abs.0, 0);
        assert_eq!(o.fee.0, 0);
        assert_eq!(o.user_receives.0, 100 * USDC);
    }

    #[test]
    fn whale_sized_numbers_do_not_overflow() {
        // 1e9 tokens at 24 decimals against a $10M basis. The u128 product of
        // those two is 1e43, which is why mul_div widens to 256 bits.
        let amount = 1_000_000_000u128 * TOK;
        let basis = 10_000_000u128 * USDC;
        let o = settle_sell(amount, basis, amount / 2, 6_000_000 * USDC, 0, true, true);
        assert_eq!(o.basis_part.0, 5_000_000 * USDC);
        assert_eq!(o.pnl.abs.0, 1_000_000 * USDC);
        assert_eq!(o.fee.0, 100_000 * USDC);
    }

    #[test]
    fn one_unit_profit_rounds_the_fee_down_to_zero() {
        let o = settle_sell(TOK, 100 * USDC, TOK, 100 * USDC + 1, 0, true, true);
        assert_eq!(o.taxable_profit.0, 1);
        assert_eq!(
            o.fee.0, 0,
            "10% of one unit rounds down, and a fee is never rounded up"
        );
        assert_eq!(o.user_receives.0, 100 * USDC + 1);
    }

    #[test]
    fn fee_split_dust_never_exceeds_the_fee() {
        // Walk a range of awkward fees and check the invariants hold every time.
        for profit in 1..500u128 {
            let o = settle_sell(TOK, 1000, TOK, 1000 + profit, 0, true, true);
            assert_eq!(o.to_trader.0 + o.to_referrer.0 + o.to_protocol.0, o.fee.0);
            assert_eq!(o.user_receives.0 + o.fee.0, 1000 + profit);
            assert!(
                o.fee.0 * 10 <= profit,
                "a fee must never exceed 10% of profit"
            );
        }
    }

    #[test]
    fn mul_div_rounds_down() {
        assert_eq!(mul_div(10, 10, 3), 33);
        assert_eq!(mul_div(u128::MAX, 1, 1), u128::MAX);
        assert_eq!(mul_div(0, 12345, 7), 0);
    }
}
