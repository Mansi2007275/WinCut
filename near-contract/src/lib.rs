//! WinCut - copy trading on NEAR where the fee only ever comes out of profit.
//!
//! * buying costs nothing
//! * selling at a loss costs nothing, and the loss is banked as a credit
//! * selling at a profit spends the credit first, then takes 10% of what is
//!   left, split 50 copied trader / 20 referrer / 30 protocol
//!
//! Users keep an internal USDC balance here. `buy` and `sell` route that
//! balance through Rhea (Ref Finance) with a real two-hop swap and settle the
//! profit, fee and credit on the way back.

mod events;
mod ft;
mod math;
#[cfg(test)]
mod tests;
mod trading;
mod types;
mod views;

pub use math::{settle_sell, FEE_DENOMINATOR, FEE_NUMERATOR, REFERRER_SHARE_PCT, TRADER_SHARE_PCT};
pub use types::*;

use near_sdk::borsh::BorshSerialize;
use near_sdk::json_types::U128;
use near_sdk::store::{IterableMap, LookupMap, Vector};
use near_sdk::{
    env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    Promise,
};

/// Native Circle USDC on NEAR mainnet, 6 decimals. Read from mainnet on
/// 2026-11-13 at block 224250070; see near-contract/addresses.near.json.
pub const USDC_TOKEN_ID: &str = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
pub const USDC_DECIMALS: u8 = 6;

/// Rhea Finance (formerly Ref Finance) classic AMM, verified at v1.9.21.
pub const RHEA_EXCHANGE_ID: &str = "v2.ref-finance.near";

/// Only the last 500 trades are kept on chain; the full history lives in the
/// NEP-297 event log.
pub const TRADE_RING_CAPACITY: u64 = 500;

/// A lock older than this is treated as abandoned. Every receipt chain here
/// settles inside a handful of blocks, so five minutes cannot be reached by a
/// healthy swap - it exists only so a lost callback cannot wedge the contract.
pub const LOCK_TIMEOUT_NS: u64 = 300 * 1_000_000_000;

pub const GAS_FT_TRANSFER: Gas = Gas::from_tgas(12);
pub const GAS_FT_BALANCE_OF: Gas = Gas::from_tgas(6);
pub const GAS_STORAGE_DEPOSIT: Gas = Gas::from_tgas(10);
/// The input token's `ft_transfer_call`, Rhea's `ft_on_transfer` with a two-hop
/// swap inside it, the output `ft_transfer` back here and both resolvers.
pub const GAS_SWAP: Gas = Gas::from_tgas(100);
/// Our resolver, plus the `ft_balance_of` it fires and the final callback.
pub const GAS_ON_SWAP: Gas = Gas::from_tgas(48);
pub const GAS_SETTLE: Gas = Gas::from_tgas(32);
pub const GAS_ON_OUTFLOW: Gas = Gas::from_tgas(12);
/// What a caller must attach to `buy` or `sell`.
pub const GAS_TRADE_MIN: Gas = Gas::from_tgas(170);

pub const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

#[derive(BorshSerialize, BorshStorageKey)]
#[borsh(crate = "near_sdk::borsh")]
enum Prefix {
    Tokens,
    Balances,
    Positions,
    UserTokens,
    TokenAccounted,
    LossCredit,
    Claimable,
    Trades,
    Traders,
    FollowEdges,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct WinCut {
    owner_id: AccountId,
    usdc_id: AccountId,
    ref_id: AccountId,

    /// Tradable tokens and the Rhea route that reaches each one from USDC.
    tokens: IterableMap<AccountId, TokenConfig>,

    /// Internal USDC balances, raw 6-decimal units.
    balances: LookupMap<AccountId, u128>,
    /// Sum of `balances` and `claimable`. The USDC this contract really holds
    /// minus this number is, under the swap lock, exactly the proceeds of the
    /// sell that just settled.
    usdc_accounted: u128,

    positions: LookupMap<(AccountId, AccountId), Position>,
    /// Tokens each user has ever opened a position in, so `get_positions` can
    /// enumerate without scanning the world.
    user_tokens: LookupMap<AccountId, Vec<AccountId>>,
    /// Per-token sum of all positions. Same trick as `usdc_accounted`, for the
    /// buy side.
    token_accounted: LookupMap<AccountId, u128>,

    /// Banked losses, raw USDC units. Global per user across every token, no expiry.
    loss_credit: LookupMap<AccountId, u128>,
    /// Earned-but-unpaid USDC for traders, referrers and the protocol.
    claimable: LookupMap<AccountId, u128>,

    /// Ring buffer of the most recent trades.
    trades: Vector<Trade>,
    total_trades: u64,

    traders: IterableMap<AccountId, TraderStats>,
    /// (trader, follower) pairs already counted, so a follower is counted once.
    follow_edges: LookupMap<(AccountId, AccountId), bool>,

    /// The single in-flight operation. Held by a swap or by a USDC payout, both
    /// of which would otherwise disturb a balance measurement in flight.
    lock: Option<SwapLock>,

    /// USDC owed to users because a Rhea payout landed in Rhea's own ledger
    /// instead of here. Users are made whole immediately; `sweep_rhea`
    /// recovers the funds. Normally zero.
    shortfall_usdc: u128,

    paused: bool,
}

#[ext_contract(ext_ft)]
pub trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> U128;
    fn ft_balance_of(&self, account_id: AccountId) -> U128;
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>);
}

#[ext_contract(ext_rhea)]
pub trait RheaExchange {
    /// Pulls a token out of our internal Rhea balance back into this contract.
    fn withdraw(&mut self, token_id: AccountId, amount: U128, unregister: Option<bool>) -> Promise;
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>);
    fn get_deposit(&self, account_id: AccountId, token_id: AccountId) -> U128;
}

#[near]
impl WinCut {
    #[init]
    pub fn new(owner_id: AccountId, usdc_id: Option<AccountId>, ref_id: Option<AccountId>) -> Self {
        let usdc_id = usdc_id.unwrap_or_else(|| USDC_TOKEN_ID.parse().unwrap());
        let ref_id = ref_id.unwrap_or_else(|| RHEA_EXCHANGE_ID.parse().unwrap());
        Self {
            owner_id,
            usdc_id,
            ref_id,
            tokens: IterableMap::new(Prefix::Tokens),
            balances: LookupMap::new(Prefix::Balances),
            usdc_accounted: 0,
            positions: LookupMap::new(Prefix::Positions),
            user_tokens: LookupMap::new(Prefix::UserTokens),
            token_accounted: LookupMap::new(Prefix::TokenAccounted),
            loss_credit: LookupMap::new(Prefix::LossCredit),
            claimable: LookupMap::new(Prefix::Claimable),
            trades: Vector::new(Prefix::Trades),
            total_trades: 0,
            traders: IterableMap::new(Prefix::Traders),
            follow_edges: LookupMap::new(Prefix::FollowEdges),
            lock: None,
            shortfall_usdc: 0,
            paused: false,
        }
    }

    // ---------------------------------------------------------------- admin

    /// Lists a token and records the Rhea route that reaches it from USDC.
    /// Does not mark it tradable - call `register_token` for that.
    pub fn list_token(
        &mut self,
        token_id: AccountId,
        symbol: String,
        decimals: u8,
        hops: Vec<Hop>,
        chart_pool: String,
    ) {
        self.assert_owner();
        require!(!hops.is_empty(), "a token needs at least one hop");
        require!(
            hops[0].token_in == self.usdc_id,
            "the first hop must spend USDC"
        );
        require!(
            hops[hops.len() - 1].token_out == token_id,
            "the last hop must produce the listed token"
        );
        for pair in hops.windows(2) {
            require!(
                pair[0].token_out == pair[1].token_in,
                "the hops do not join up"
            );
        }
        let registered = self
            .tokens
            .get(&token_id)
            .map(|t| t.registered)
            .unwrap_or(false);
        self.tokens.insert(
            token_id.clone(),
            TokenConfig {
                token_id: token_id.clone(),
                symbol: symbol.clone(),
                decimals,
                hops,
                registered,
                chart_pool,
            },
        );
        events::token_listed(&token_id, &symbol);
    }

    /// Pays NEP-145 storage for this contract on `token_id` and on Rhea, then
    /// marks the token tradable. Until this runs, a swap could succeed on Rhea
    /// and then fail to pay out, stranding the proceeds.
    #[payable]
    pub fn register_token(&mut self, token_id: AccountId) -> Promise {
        self.assert_owner();
        require!(self.tokens.contains_key(&token_id), "list the token first");
        let deposit = env::attached_deposit();
        require!(
            deposit >= NearToken::from_millinear(20),
            "attach at least 0.02 NEAR to cover both storage deposits"
        );
        let half = NearToken::from_yoctonear(deposit.as_yoctonear() / 2);
        ext_ft::ext(token_id.clone())
            .with_attached_deposit(half)
            .with_static_gas(GAS_STORAGE_DEPOSIT)
            .storage_deposit(Some(env::current_account_id()), Some(true))
            .then(
                ext_rhea::ext(self.ref_id.clone())
                    .with_attached_deposit(half)
                    .with_static_gas(GAS_STORAGE_DEPOSIT)
                    .storage_deposit(Some(env::current_account_id()), Some(false)),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(8))
                    .on_token_registered(token_id),
            )
    }

    #[private]
    pub fn on_token_registered(&mut self, token_id: AccountId) -> bool {
        // Only whether it succeeded matters; NEP-145 returns a StorageBalance
        // whose shape differs between tokens, so the body is not deserialised.
        let ok = env::promise_result_checked(0, 512).is_ok();
        if ok {
            if let Some(cfg) = self.tokens.get_mut(&token_id) {
                cfg.registered = true;
            }
        }
        ok
    }

    pub fn set_paused(&mut self, paused: bool) {
        self.assert_owner();
        self.paused = paused;
    }

    pub fn set_owner(&mut self, owner_id: AccountId) {
        self.assert_owner();
        self.owner_id = owner_id;
    }

    /// Clears a lock that has outlived `LOCK_TIMEOUT_NS`. Callable by anyone so
    /// that a lost callback can never wedge trading permanently. It refunds the
    /// locked side conservatively: the user gets their input back, because a
    /// swap this old has either been refunded by the token contract or is lost.
    pub fn release_stale_lock(&mut self) -> bool {
        let Some(lock) = self.lock.clone() else {
            return false;
        };
        require!(
            env::block_timestamp().saturating_sub(lock.started_at) > LOCK_TIMEOUT_NS,
            "the lock is still fresh"
        );
        self.lock = None;
        env::log_str(&format!(
            "released a stale {:?} lock held by {}",
            lock.kind, lock.user
        ));
        true
    }

    /// Recovers tokens that ended up in this contract's internal Rhea balance
    /// instead of being paid out - the failure mode `shortfall_usdc` records.
    pub fn sweep_rhea(&mut self, token_id: AccountId, amount: U128) -> Promise {
        self.assert_owner();
        ext_rhea::ext(self.ref_id.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(Gas::from_tgas(60))
            .withdraw(token_id, amount, Some(false))
    }

    /// Repays `shortfall_usdc` out of protocol earnings once a sweep has
    /// returned the funds to this contract.
    pub fn settle_shortfall(&mut self, amount: U128) {
        self.assert_owner();
        let amount = amount.0;
        require!(amount <= self.shortfall_usdc, "more than is owed");
        let owner = self.owner_id.clone();
        let earned = self.claimable.get(&owner).copied().unwrap_or(0);
        require!(earned >= amount, "protocol earnings do not cover it");
        self.claimable.insert(owner, earned - amount);
        self.shortfall_usdc -= amount;
    }
}

/// Internal helpers. Deliberately outside the `#[near]` block: that macro only
/// knows how to export public contract methods, and these are not callable.
impl WinCut {
    pub(crate) fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner_id, "owner only");
    }

    pub(crate) fn assert_unlocked(&self) {
        if let Some(lock) = &self.lock {
            require!(
                env::block_timestamp().saturating_sub(lock.started_at) > LOCK_TIMEOUT_NS,
                "another settlement is in flight, try again in a few seconds"
            );
        }
    }

    pub(crate) fn balance_of_internal(&self, account_id: &AccountId) -> u128 {
        self.balances.get(account_id).copied().unwrap_or(0)
    }

    pub(crate) fn credit_balance(&mut self, account_id: &AccountId, amount: u128) {
        if amount == 0 {
            return;
        }
        let next = self.balance_of_internal(account_id) + amount;
        self.balances.insert(account_id.clone(), next);
        self.usdc_accounted += amount;
    }

    pub(crate) fn debit_balance(&mut self, account_id: &AccountId, amount: u128) {
        let have = self.balance_of_internal(account_id);
        require!(have >= amount, "not enough USDC in your WinCut balance");
        self.balances.insert(account_id.clone(), have - amount);
        self.usdc_accounted -= amount;
    }

    pub(crate) fn credit_claimable(&mut self, account_id: &AccountId, amount: u128) {
        if amount == 0 {
            return;
        }
        let next = self.claimable.get(account_id).copied().unwrap_or(0) + amount;
        self.claimable.insert(account_id.clone(), next);
        self.usdc_accounted += amount;
    }

    pub(crate) fn token_held(&self, token_id: &AccountId) -> u128 {
        self.token_accounted.get(token_id).copied().unwrap_or(0)
    }

    pub(crate) fn set_token_held(&mut self, token_id: &AccountId, amount: u128) {
        self.token_accounted.insert(token_id.clone(), amount);
    }

    pub(crate) fn position_of(&self, user: &AccountId, token_id: &AccountId) -> Position {
        self.positions
            .get(&(user.clone(), token_id.clone()))
            .cloned()
            .unwrap_or_default()
    }

    pub(crate) fn save_position(&mut self, user: &AccountId, token_id: &AccountId, p: Position) {
        if p.amount.0 == 0 && p.cost_basis_usdc.0 == 0 {
            self.positions.remove(&(user.clone(), token_id.clone()));
        } else {
            self.positions.insert((user.clone(), token_id.clone()), p);
        }
    }

    pub(crate) fn remember_user_token(&mut self, user: &AccountId, token_id: &AccountId) {
        let mut list = self.user_tokens.get(user).cloned().unwrap_or_default();
        if !list.contains(token_id) {
            list.push(token_id.clone());
            self.user_tokens.insert(user.clone(), list);
        }
    }

    pub(crate) fn loss_credit_of(&self, user: &AccountId) -> u128 {
        self.loss_credit.get(user).copied().unwrap_or(0)
    }

    pub(crate) fn set_loss_credit(&mut self, user: &AccountId, amount: u128) {
        if amount == 0 {
            self.loss_credit.remove(user);
        } else {
            self.loss_credit.insert(user.clone(), amount);
        }
    }

    pub(crate) fn config_of(&self, token_id: &AccountId) -> TokenConfig {
        self.tokens
            .get(token_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("that token is not listed on WinCut"))
    }

    /// Drops a self-reference. Copying yourself or referring yourself pays
    /// nothing, so the share falls through to the protocol instead.
    pub(crate) fn sanitise_party(
        &self,
        user: &AccountId,
        party: Option<AccountId>,
    ) -> Option<AccountId> {
        match party {
            Some(p) if &p != user => Some(p),
            _ => None,
        }
    }

    pub(crate) fn push_trade(&mut self, trade: Trade) {
        if (self.trades.len() as u64) < TRADE_RING_CAPACITY {
            self.trades.push(trade);
        } else {
            let slot = (self.total_trades % TRADE_RING_CAPACITY) as u32;
            self.trades.replace(slot, trade);
        }
        self.total_trades += 1;
    }

    pub(crate) fn stats_of(&self, account_id: &AccountId) -> TraderStats {
        self.traders.get(account_id).cloned().unwrap_or_default()
    }

    pub(crate) fn save_stats(&mut self, account_id: &AccountId, s: TraderStats) {
        self.traders.insert(account_id.clone(), s);
    }

    /// Counts `follower` against `trader` the first time only.
    pub(crate) fn note_follow(&mut self, trader: &AccountId, follower: &AccountId) {
        let key = (trader.clone(), follower.clone());
        if self.follow_edges.contains_key(&key) {
            return;
        }
        self.follow_edges.insert(key, true);
        let mut s = self.stats_of(trader);
        s.followers += 1;
        self.save_stats(trader, s);
    }
}
