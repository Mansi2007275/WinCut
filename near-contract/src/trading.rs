//! Buying and selling through Rhea, and the settlement that turns a swap into
//! a position, a profit, a loss credit and a fee split.
//!
//! ## How the output of a swap is attributed
//!
//! Rhea's instant swap (a `ft_transfer_call` carrying swap actions) does not
//! report how much came out: `ft_transfer_call` only returns how much of the
//! *input* was used. So the amount out is measured, not reported:
//!
//! 1. the contract knows exactly how much of each token it ought to hold -
//!    `token_accounted` for tokens, `usdc_accounted` for USDC
//! 2. a global lock means only one swap or payout is in flight at a time
//! 3. after the swap resolves, the callback asks the token for the real
//!    balance, and the difference from the accounted figure is the output
//!
//! The measuring read is deliberately a *second* round trip. Rhea pays the
//! output out in a receipt created while its `ft_on_transfer` runs, so that
//! receipt is queued on the token's shard strictly before the `ft_balance_of`
//! this contract sends two blocks later. Shards drain their receipt queues in
//! order, so the payout is always already applied when the balance is read.

use crate::events;
use crate::math::settle_sell;
use crate::types::{Hop, I128Json, LockKind, Position, Side, SwapLock, Trade};
use crate::{
    ext_ft, WinCut, WinCutExt, GAS_FT_BALANCE_OF, GAS_ON_SWAP, GAS_SETTLE, GAS_SWAP, GAS_TRADE_MIN,
    ONE_YOCTO,
};
use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{env, near, require, AccountId, PromiseError, PromiseOrValue};

#[near]
impl WinCut {
    /// Spends USDC from the caller's internal balance on `token_id`.
    ///
    /// * `min_out` - raw token units, below which Rhea refuses the swap and the
    ///   USDC comes straight back to the internal balance
    /// * `followed` - the trader being copied, who earns 50% of any future
    ///   profit fee on this position
    /// * `referrer` - earns 20%
    ///
    /// Naming yourself as either is ignored; that share falls to the protocol.
    /// WinCut charges nothing here - a buy only ever costs Rhea's pool fee and
    /// NEAR gas.
    pub fn buy(
        &mut self,
        token_id: AccountId,
        usdc_in: U128,
        min_out: U128,
        followed: Option<AccountId>,
        referrer: Option<AccountId>,
    ) -> PromiseOrValue<bool> {
        require!(!self.paused, "WinCut is paused");
        require!(
            env::prepaid_gas() >= GAS_TRADE_MIN,
            "attach at least 170 Tgas: the swap, the balance read and the settlement all have to fit"
        );
        let user = env::predecessor_account_id();
        let cfg = self.config_of(&token_id);
        require!(
            cfg.registered,
            "that token is listed but not registered for trading yet"
        );
        require!(usdc_in.0 > 0, "nothing to spend");
        self.assert_unlocked();

        let followed = self.sanitise_party(&user, followed);
        let referrer = self.sanitise_party(&user, referrer);

        self.debit_balance(&user, usdc_in.0);

        let position = self.position_of(&user, &token_id);
        self.lock = Some(SwapLock {
            user: user.clone(),
            token_id: token_id.clone(),
            kind: LockKind::Buy,
            amount_in: usdc_in,
            position_amount_before: position.amount,
            cost_basis_before: position.cost_basis_usdc,
            min_out,
            followed,
            referrer,
            started_at: env::block_timestamp(),
        });

        let msg = build_swap_msg(&cfg.hops, false, usdc_in.0, min_out.0);
        PromiseOrValue::Promise(
            ext_ft::ext(self.usdc_id.clone())
                .with_attached_deposit(ONE_YOCTO)
                .with_static_gas(GAS_SWAP)
                .ft_transfer_call(self.ref_id.clone(), usdc_in, None, msg)
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(GAS_ON_SWAP)
                        .on_buy_swapped(),
                ),
        )
    }

    /// Sells `amount` raw token units back to USDC and settles the profit.
    ///
    /// * at a loss: no fee at all, and the loss is banked as a credit
    /// * at a profit: the credit is spent first, then 10% of what is left
    ///
    /// `quote_sell_fee` returns the exact numbers this will produce for a given
    /// expected proceeds, so the UI can show the fee before the user signs.
    pub fn sell(
        &mut self,
        token_id: AccountId,
        amount: U128,
        min_out_usdc: U128,
    ) -> PromiseOrValue<bool> {
        require!(!self.paused, "WinCut is paused");
        require!(
            env::prepaid_gas() >= GAS_TRADE_MIN,
            "attach at least 170 Tgas: the swap, the balance read and the settlement all have to fit"
        );
        let user = env::predecessor_account_id();
        let cfg = self.config_of(&token_id);
        require!(cfg.registered, "that token is not registered for trading");
        require!(amount.0 > 0, "nothing to sell");

        let position = self.position_of(&user, &token_id);
        require!(position.amount.0 >= amount.0, "you do not hold that much");
        self.assert_unlocked();

        self.lock = Some(SwapLock {
            user: user.clone(),
            token_id: token_id.clone(),
            kind: LockKind::Sell,
            amount_in: amount,
            position_amount_before: position.amount,
            cost_basis_before: position.cost_basis_usdc,
            min_out: min_out_usdc,
            followed: position.followed.clone(),
            referrer: position.referrer.clone(),
            started_at: env::block_timestamp(),
        });

        let msg = build_swap_msg(&cfg.hops, true, amount.0, min_out_usdc.0);
        PromiseOrValue::Promise(
            ext_ft::ext(token_id)
                .with_attached_deposit(ONE_YOCTO)
                .with_static_gas(GAS_SWAP)
                .ft_transfer_call(self.ref_id.clone(), amount, None, msg)
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(GAS_ON_SWAP)
                        .on_sell_swapped(),
                ),
        )
    }

    // ------------------------------------------------------------ callbacks

    /// First half of a buy: find out how much USDC Rhea consumed, refund the
    /// rest, then go and measure what came back.
    #[private]
    pub fn on_buy_swapped(
        &mut self,
        #[callback_result] used: Result<U128, PromiseError>,
    ) -> PromiseOrValue<bool> {
        let Some(lock) = self.lock.clone() else {
            env::log_str("on_buy_swapped fired with no lock held; ignoring");
            return PromiseOrValue::Value(false);
        };
        if lock.kind != LockKind::Buy {
            env::log_str("on_buy_swapped fired while a different operation held the lock");
            return PromiseOrValue::Value(false);
        }

        let spent = match used {
            Ok(u) => u.0.min(lock.amount_in.0),
            Err(_) => 0,
        };
        let refund = lock.amount_in.0 - spent;
        if refund > 0 {
            self.credit_balance(&lock.user, refund);
        }
        if spent == 0 {
            // Rhea refused the swap - slippage, or a pool that moved. The user
            // is whole again and nothing else happened.
            self.release_lock(LockKind::Buy);
            events::swap_failed(&lock.user, &lock.token_id, LockKind::Buy, refund);
            return PromiseOrValue::Value(false);
        }

        PromiseOrValue::Promise(
            ext_ft::ext(lock.token_id.clone())
                .with_static_gas(GAS_FT_BALANCE_OF)
                .ft_balance_of(env::current_account_id())
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(GAS_SETTLE)
                        .on_buy_settled(U128(spent)),
                ),
        )
    }

    /// Second half of a buy: the measured balance minus what the contract was
    /// already holding is this user's output.
    #[private]
    pub fn on_buy_settled(
        &mut self,
        spent: U128,
        #[callback_result] balance: Result<U128, PromiseError>,
    ) -> bool {
        let Some(lock) = self.lock.clone() else {
            env::log_str("on_buy_settled fired with no lock held; ignoring");
            return false;
        };
        if lock.kind != LockKind::Buy {
            return false;
        }
        self.release_lock(LockKind::Buy);

        let held = self.token_held(&lock.token_id);
        let measured = match balance {
            Ok(b) => b.0,
            Err(_) => {
                // The balance read itself failed, which leaves the output
                // unattributable. Make the user whole and flag the gap.
                self.make_whole(&lock.user, &lock.token_id, spent.0);
                return false;
            }
        };
        let out = measured.saturating_sub(held);
        if out == 0 {
            // Rhea reported a fill but nothing arrived, so the proceeds are
            // sitting in Rhea's ledger for this contract. `sweep_rhea`
            // recovers them; the user is refunded now, not later.
            self.make_whole(&lock.user, &lock.token_id, spent.0);
            return false;
        }

        // Trust the measurement over the running total, so any drift self-heals.
        self.set_token_held(&lock.token_id, measured);

        let mut position = self.position_of(&lock.user, &lock.token_id);
        position.amount = U128(position.amount.0 + out);
        position.cost_basis_usdc = U128(position.cost_basis_usdc.0 + spent.0);
        if position.opened_at == 0 {
            position.opened_at = env::block_timestamp();
        }
        // The first buy fixes who gets paid; adding to a position later cannot
        // re-point the attribution at someone else.
        if position.followed.is_none() {
            position.followed = lock.followed.clone();
        }
        if position.referrer.is_none() {
            position.referrer = lock.referrer.clone();
        }
        let followed = position.followed.clone();
        let referrer = position.referrer.clone();
        let (pos_amount, pos_basis) = (position.amount, position.cost_basis_usdc);
        self.save_position(&lock.user, &lock.token_id, position);
        self.remember_user_token(&lock.user, &lock.token_id);

        if let Some(trader) = &followed {
            self.note_follow(trader, &lock.user);
        }
        let mut stats = self.stats_of(&lock.user);
        stats.volume_usdc = U128(stats.volume_usdc.0 + spent.0);
        stats.trades += 1;
        self.save_stats(&lock.user, stats);

        let id = self.total_trades;
        self.push_trade(Trade {
            id,
            user: lock.user.clone(),
            token_id: lock.token_id.clone(),
            side: Side::Buy,
            amount: U128(out),
            usdc: spent,
            pnl: None,
            fee: U128(0),
            followed: followed.clone(),
            timestamp: env::block_timestamp(),
        });

        events::buy(
            &lock.user,
            &lock.token_id,
            spent.0,
            out,
            pos_amount.0,
            pos_basis.0,
            &followed,
            &referrer,
        );
        true
    }

    /// First half of a sell: find out how many tokens Rhea took.
    #[private]
    pub fn on_sell_swapped(
        &mut self,
        #[callback_result] used: Result<U128, PromiseError>,
    ) -> PromiseOrValue<bool> {
        let Some(lock) = self.lock.clone() else {
            env::log_str("on_sell_swapped fired with no lock held; ignoring");
            return PromiseOrValue::Value(false);
        };
        if lock.kind != LockKind::Sell {
            return PromiseOrValue::Value(false);
        }

        let sold = match used {
            Ok(u) => u.0.min(lock.amount_in.0),
            Err(_) => 0,
        };
        if sold == 0 {
            // The tokens bounced straight back, so the position is untouched.
            self.release_lock(LockKind::Sell);
            events::swap_failed(&lock.user, &lock.token_id, LockKind::Sell, lock.amount_in.0);
            return PromiseOrValue::Value(false);
        }

        // Those tokens have left the building.
        let held = self.token_held(&lock.token_id);
        self.set_token_held(&lock.token_id, held.saturating_sub(sold));

        PromiseOrValue::Promise(
            ext_ft::ext(self.usdc_id.clone())
                .with_static_gas(GAS_FT_BALANCE_OF)
                .ft_balance_of(env::current_account_id())
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(GAS_SETTLE)
                        .on_sell_settled(U128(sold)),
                ),
        )
    }

    /// Second half of a sell, and the only place a fee is ever charged.
    #[private]
    pub fn on_sell_settled(
        &mut self,
        sold: U128,
        #[callback_result] balance: Result<U128, PromiseError>,
    ) -> bool {
        let Some(lock) = self.lock.clone() else {
            env::log_str("on_sell_settled fired with no lock held; ignoring");
            return false;
        };
        if lock.kind != LockKind::Sell {
            return false;
        }
        self.release_lock(LockKind::Sell);

        let measured = match balance {
            Ok(b) => b.0,
            Err(_) => {
                // The proceeds are here but unmeasurable. Hand the position
                // back rather than guess at a profit.
                self.restore_position(&lock, sold.0);
                return false;
            }
        };
        let proceeds = measured.saturating_sub(self.usdc_accounted);
        if proceeds == 0 {
            self.restore_position(&lock, sold.0);
            return false;
        }

        let outcome = settle_sell(
            lock.position_amount_before.0,
            lock.cost_basis_before.0,
            sold.0,
            proceeds,
            self.loss_credit_of(&lock.user),
            lock.followed.is_some(),
            lock.referrer.is_some(),
        );

        // Shrink the position by what was sold and by its share of the basis.
        let remaining = lock.position_amount_before.0 - sold.0;
        let position = Position {
            amount: U128(remaining),
            cost_basis_usdc: U128(if remaining == 0 {
                0
            } else {
                lock.cost_basis_before.0 - outcome.basis_part.0
            }),
            followed: lock.followed.clone(),
            referrer: lock.referrer.clone(),
            opened_at: self.position_of(&lock.user, &lock.token_id).opened_at,
        };
        self.save_position(&lock.user, &lock.token_id, position);

        self.set_loss_credit(&lock.user, outcome.loss_credit_after.0);

        // The user's cut, then the fee split. These three credits add up to
        // exactly `proceeds`, which is what actually arrived.
        self.credit_balance(&lock.user, outcome.user_receives.0);
        if let Some(trader) = &lock.followed {
            self.credit_claimable(trader, outcome.to_trader.0);
            let mut s = self.stats_of(trader);
            s.earnings_usdc = U128(s.earnings_usdc.0 + outcome.to_trader.0);
            self.save_stats(trader, s);
        }
        if let Some(referrer) = &lock.referrer {
            self.credit_claimable(referrer, outcome.to_referrer.0);
        }
        let owner = self.owner_id.clone();
        self.credit_claimable(&owner, outcome.to_protocol.0);

        let pnl: I128Json = outcome.pnl.into();
        let mut stats = self.stats_of(&lock.user);
        stats.volume_usdc = U128(stats.volume_usdc.0 + proceeds);
        stats.trades += 1;
        if pnl.negative {
            stats.losses += 1;
            let p = &mut stats.realised_pnl;
            if p.negative {
                p.abs = U128(p.abs.0 + pnl.abs.0);
            } else if p.abs.0 >= pnl.abs.0 {
                p.abs = U128(p.abs.0 - pnl.abs.0);
            } else {
                *p = I128Json {
                    negative: true,
                    abs: U128(pnl.abs.0 - p.abs.0),
                };
            }
        } else {
            if pnl.abs.0 > 0 {
                stats.wins += 1;
            }
            let p = &mut stats.realised_pnl;
            if p.negative {
                if p.abs.0 > pnl.abs.0 {
                    p.abs = U128(p.abs.0 - pnl.abs.0);
                } else {
                    *p = I128Json::profit(pnl.abs.0 - p.abs.0);
                }
            } else {
                p.abs = U128(p.abs.0 + pnl.abs.0);
            }
        }
        self.save_stats(&lock.user, stats);

        let id = self.total_trades;
        self.push_trade(Trade {
            id,
            user: lock.user.clone(),
            token_id: lock.token_id.clone(),
            side: Side::Sell,
            amount: sold,
            usdc: U128(proceeds),
            pnl: Some(pnl),
            fee: outcome.fee,
            followed: lock.followed.clone(),
            timestamp: env::block_timestamp(),
        });

        events::sell(
            &lock.user,
            &lock.token_id,
            sold.0,
            proceeds,
            &pnl,
            outcome.fee.0,
            outcome.credit_used.0,
            outcome.credit_banked.0,
            outcome.loss_credit_after.0,
            outcome.to_trader.0,
            outcome.to_referrer.0,
            outcome.to_protocol.0,
            &lock.followed,
            &lock.referrer,
        );
        true
    }

    // ------------------------------------------------------- failure repair

    /// A swap Rhea says it filled, whose output never landed here. The user is
    /// refunded immediately out of the protocol's own skin and the gap is
    /// recorded for `sweep_rhea` to recover.
    fn make_whole(&mut self, user: &AccountId, token_id: &AccountId, usdc: u128) {
        self.credit_balance(user, usdc);
        self.shortfall_usdc += usdc;
        events::shortfall(user, token_id, usdc, self.shortfall_usdc);
    }

    /// Puts tokens back into the position when a sell cannot be settled.
    fn restore_position(&mut self, lock: &SwapLock, sold: u128) {
        let held = self.token_held(&lock.token_id);
        self.set_token_held(&lock.token_id, held + sold);
        events::swap_failed(&lock.user, &lock.token_id, LockKind::Sell, sold);
        env::log_str(
            "the sell proceeds could not be measured; the position was left intact and no fee was charged",
        );
    }
}

/// Builds the `msg` for Rhea's instant swap.
///
/// Rhea reads an untagged `{"actions":[...]}`; only the first action carries
/// `amount_in`, and every later one spends what the previous one produced.
/// `min_amount_out` is zero on the intermediate hops because only the final
/// output is what the user agreed to.
pub fn build_swap_msg(hops: &[Hop], reverse: bool, amount_in: u128, min_out: u128) -> String {
    let mut actions = Vec::with_capacity(hops.len());
    let count = hops.len();
    for i in 0..count {
        // Selling walks the same pools backwards, swapping each hop's ends.
        let hop = if reverse {
            &hops[count - 1 - i]
        } else {
            &hops[i]
        };
        let (token_in, token_out) = if reverse {
            (&hop.token_out, &hop.token_in)
        } else {
            (&hop.token_in, &hop.token_out)
        };
        let last = i == count - 1;
        let mut action = json!({
            "pool_id": hop.pool_id,
            "token_in": token_in,
            "token_out": token_out,
            "min_amount_out": U128(if last { min_out } else { 0 }),
        });
        if i == 0 {
            action["amount_in"] = json!(U128(amount_in));
        }
        actions.push(action);
    }
    json!({ "actions": actions }).to_string()
}

#[cfg(test)]
mod tests {
    use super::build_swap_msg;
    use crate::types::Hop;

    fn hops() -> Vec<Hop> {
        vec![
            Hop {
                pool_id: 4512,
                token_in: "usdc.near".parse().unwrap(),
                token_out: "wrap.near".parse().unwrap(),
            },
            Hop {
                pool_id: 6458,
                token_in: "wrap.near".parse().unwrap(),
                token_out: "token.rhealab.near".parse().unwrap(),
            },
        ]
    }

    #[test]
    fn a_buy_walks_the_hops_forwards_and_only_prices_the_last_one() {
        let msg = build_swap_msg(&hops(), false, 100_000_000, 42);
        let v: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(&msg).unwrap();
        let a = v["actions"].as_array().unwrap();
        assert_eq!(a.len(), 2);
        assert_eq!(a[0]["pool_id"], 4512);
        assert_eq!(a[0]["token_in"], "usdc.near");
        assert_eq!(a[0]["token_out"], "wrap.near");
        assert_eq!(a[0]["amount_in"], "100000000");
        assert_eq!(
            a[0]["min_amount_out"], "0",
            "an intermediate hop is not what the user priced"
        );
        assert_eq!(a[1]["pool_id"], 6458);
        assert_eq!(a[1]["token_out"], "token.rhealab.near");
        assert_eq!(a[1]["min_amount_out"], "42");
        assert!(
            a[1].get("amount_in").is_none(),
            "later hops spend the previous output"
        );
    }

    #[test]
    fn a_sell_walks_the_same_pools_backwards() {
        let msg = build_swap_msg(&hops(), true, 7, 99);
        let v: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(&msg).unwrap();
        let a = v["actions"].as_array().unwrap();
        assert_eq!(a[0]["pool_id"], 6458);
        assert_eq!(a[0]["token_in"], "token.rhealab.near");
        assert_eq!(a[0]["token_out"], "wrap.near");
        assert_eq!(a[0]["amount_in"], "7");
        assert_eq!(a[1]["pool_id"], 4512);
        assert_eq!(a[1]["token_in"], "wrap.near");
        assert_eq!(a[1]["token_out"], "usdc.near");
        assert_eq!(a[1]["min_amount_out"], "99");
    }

    #[test]
    fn a_single_hop_token_prices_its_only_action() {
        let one = vec![hops()[0].clone()];
        let msg = build_swap_msg(&one, false, 5, 6);
        let v: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(&msg).unwrap();
        let a = v["actions"].as_array().unwrap();
        assert_eq!(a.len(), 1);
        assert_eq!(a[0]["amount_in"], "5");
        assert_eq!(a[0]["min_amount_out"], "6");
    }
}
