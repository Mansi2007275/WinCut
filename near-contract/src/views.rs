//! Read-only methods. Everything the frontend puts on screen comes from here,
//! from Rhea, or from GeckoTerminal - nothing is invented client side.

use crate::math::{settle_sell, FEE_NUMERATOR, REFERRER_SHARE_PCT, TRADER_SHARE_PCT};
use crate::types::{
    ContractConfig, LeaderboardRow, Position, PositionView, SellOutcome, TokenConfig, Trade,
};
use crate::{WinCut, WinCutExt, TRADE_RING_CAPACITY};
use near_sdk::json_types::U128;
use near_sdk::{near, AccountId};

#[near]
impl WinCut {
    pub fn get_config(&self) -> ContractConfig {
        ContractConfig {
            owner_id: self.owner_id.clone(),
            usdc_id: self.usdc_id.clone(),
            ref_id: self.ref_id.clone(),
            fee_bps_of_profit: (FEE_NUMERATOR * 100) as u16,
            trader_share_pct: TRADER_SHARE_PCT as u8,
            referrer_share_pct: REFERRER_SHARE_PCT as u8,
            protocol_share_pct: (100 - TRADER_SHARE_PCT - REFERRER_SHARE_PCT) as u8,
            paused: self.paused,
            swap_in_flight: self.lock.is_some(),
            total_trades: self.total_trades,
            trade_ring_capacity: TRADE_RING_CAPACITY,
            shortfall_usdc: U128(self.shortfall_usdc),
        }
    }

    pub fn get_tokens(&self) -> Vec<TokenConfig> {
        self.tokens.values().cloned().collect()
    }

    pub fn get_token(&self, token_id: AccountId) -> Option<TokenConfig> {
        self.tokens.get(&token_id).cloned()
    }

    /// The caller's spendable USDC inside WinCut, raw 6-decimal units.
    pub fn get_balance(&self, account_id: AccountId) -> U128 {
        U128(self.balance_of_internal(&account_id))
    }

    pub fn get_position(&self, account_id: AccountId, token_id: AccountId) -> Option<Position> {
        self.positions.get(&(account_id, token_id)).cloned()
    }

    /// Every open position, with the symbol and decimals needed to render it.
    pub fn get_positions(&self, account_id: AccountId) -> Vec<PositionView> {
        let tokens = self
            .user_tokens
            .get(&account_id)
            .cloned()
            .unwrap_or_default();
        tokens
            .into_iter()
            .filter_map(|token_id| {
                let p = self
                    .positions
                    .get(&(account_id.clone(), token_id.clone()))?;
                if p.amount.0 == 0 {
                    return None;
                }
                let cfg = self.tokens.get(&token_id);
                Some(PositionView {
                    token_id: token_id.clone(),
                    symbol: cfg.map(|c| c.symbol.clone()).unwrap_or_default(),
                    decimals: cfg.map(|c| c.decimals).unwrap_or(0),
                    amount: p.amount,
                    cost_basis_usdc: p.cost_basis_usdc,
                    followed: p.followed.clone(),
                    referrer: p.referrer.clone(),
                    opened_at: p.opened_at,
                })
            })
            .collect()
    }

    /// Banked losses, raw USDC units. Global across every token, never expires,
    /// and spent before any profit fee is charged.
    pub fn get_loss_credit(&self, account_id: AccountId) -> U128 {
        U128(self.loss_credit_of(&account_id))
    }

    /// Earned but unpaid USDC, as a copied trader, a referrer or the protocol.
    pub fn get_claimable(&self, account_id: AccountId) -> U128 {
        U128(self.claimable.get(&account_id).copied().unwrap_or(0))
    }

    /// The most recent trades, newest first. `from` skips that many from the
    /// newest end, so `(0, 50)` is the latest page.
    ///
    /// Only the last `TRADE_RING_CAPACITY` trades live on chain; older ones
    /// remain in the NEP-297 event log.
    pub fn get_recent_trades(&self, from: Option<u64>, limit: Option<u64>) -> Vec<Trade> {
        let stored = self.trades.len() as u64;
        if stored == 0 {
            return vec![];
        }
        let from = from.unwrap_or(0);
        let limit = limit.unwrap_or(50).min(stored);
        // Newest slot first, walking the ring backwards.
        (0..stored)
            .filter_map(|back| {
                let offset = back + from;
                if offset >= stored {
                    return None;
                }
                let slot = (self.total_trades + stored - 1 - offset) % stored;
                self.trades.get(slot as u32).cloned()
            })
            .take(limit as usize)
            .collect()
    }

    /// A user's own trades, newest first, filtered out of the on-chain ring.
    pub fn get_trades_of(&self, account_id: AccountId, limit: Option<u64>) -> Vec<Trade> {
        let limit = limit.unwrap_or(50) as usize;
        self.get_recent_trades(Some(0), Some(TRADE_RING_CAPACITY))
            .into_iter()
            .filter(|t| t.user == account_id)
            .take(limit)
            .collect()
    }

    /// Trades whose position names `trader` as the copied trader - the copy feed.
    pub fn get_copy_feed(&self, trader: AccountId, limit: Option<u64>) -> Vec<Trade> {
        let limit = limit.unwrap_or(50) as usize;
        self.get_recent_trades(Some(0), Some(TRADE_RING_CAPACITY))
            .into_iter()
            .filter(|t| t.followed.as_ref() == Some(&trader))
            .take(limit)
            .collect()
    }

    pub fn get_trader(&self, account_id: AccountId) -> LeaderboardRow {
        let s = self.stats_of(&account_id);
        LeaderboardRow {
            account_id,
            realised_pnl: s.realised_pnl,
            volume_usdc: s.volume_usdc,
            followers: s.followers,
            earnings_usdc: s.earnings_usdc,
            trades: s.trades,
            wins: s.wins,
            losses: s.losses,
        }
    }

    /// Traders ranked by realised profit, best first. Losses sort below every
    /// profit. Reads the whole trader map, which is fine at this size and is
    /// noted as a scaling limit in the README.
    pub fn get_leaderboard(&self, limit: Option<u64>) -> Vec<LeaderboardRow> {
        let mut rows: Vec<LeaderboardRow> = self
            .traders
            .iter()
            .map(|(account_id, s)| LeaderboardRow {
                account_id: account_id.clone(),
                realised_pnl: s.realised_pnl,
                volume_usdc: s.volume_usdc,
                followers: s.followers,
                earnings_usdc: s.earnings_usdc,
                trades: s.trades,
                wins: s.wins,
                losses: s.losses,
            })
            .collect();
        rows.sort_by(|a, b| {
            let key = |r: &LeaderboardRow| -> i128 {
                if r.realised_pnl.negative {
                    -(r.realised_pnl.abs.0 as i128)
                } else {
                    r.realised_pnl.abs.0 as i128
                }
            };
            key(b)
                .cmp(&key(a))
                .then(b.volume_usdc.0.cmp(&a.volume_usdc.0))
        });
        rows.truncate(limit.unwrap_or(25) as usize);
        rows
    }

    /// Exactly what `sell` would do if the swap returned `expected_proceeds`.
    ///
    /// This is the same pure function the settlement callback runs, so the
    /// "fee if you sell now" the UI shows is the fee that gets charged, give or
    /// take the slippage between the quote and the fill.
    pub fn quote_sell_fee(
        &self,
        account_id: AccountId,
        token_id: AccountId,
        amount: U128,
        expected_proceeds: U128,
    ) -> SellOutcome {
        let p = self
            .positions
            .get(&(account_id.clone(), token_id))
            .cloned()
            .unwrap_or_default();
        if p.amount.0 == 0 || amount.0 == 0 || amount.0 > p.amount.0 {
            return SellOutcome {
                loss_credit_before: U128(self.loss_credit_of(&account_id)),
                loss_credit_after: U128(self.loss_credit_of(&account_id)),
                ..Default::default()
            };
        }
        settle_sell(
            p.amount.0,
            p.cost_basis_usdc.0,
            amount.0,
            expected_proceeds.0,
            self.loss_credit_of(&account_id),
            p.followed.is_some(),
            p.referrer.is_some(),
        )
    }

    /// The same calculation with no position required, for the landing page
    /// fee calculator: "you put in $X and take out $Y".
    pub fn quote_fee_for(
        &self,
        cost_basis: U128,
        proceeds: U128,
        loss_credit: U128,
        has_trader: bool,
        has_referrer: bool,
    ) -> SellOutcome {
        settle_sell(
            1_000_000_000_000_000_000,
            cost_basis.0,
            1_000_000_000_000_000_000,
            proceeds.0,
            loss_credit.0,
            has_trader,
            has_referrer,
        )
    }

    /// Raw token units this contract believes it holds for all positions in
    /// `token_id`. Exposed so the accounting can be audited from outside
    /// against the token's own `ft_balance_of`.
    pub fn get_token_accounted(&self, token_id: AccountId) -> U128 {
        U128(self.token_held(&token_id))
    }

    /// Raw USDC units owed to users: every internal balance plus every unpaid
    /// claim. Should always equal this contract's USDC balance minus any
    /// reported shortfall.
    pub fn get_usdc_accounted(&self) -> U128 {
        U128(self.usdc_accounted)
    }
}
