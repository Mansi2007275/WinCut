//! Money in and money out: NEP-141 deposits, withdrawals and fee claims.

use crate::events;
use crate::types::{LockKind, SwapLock};
use crate::{ext_ft, WinCut, WinCutExt, GAS_FT_TRANSFER, GAS_ON_OUTFLOW, ONE_YOCTO};
use near_sdk::json_types::U128;
use near_sdk::{env, near, require, AccountId, PromiseError, PromiseOrValue};

#[near]
impl WinCut {
    /// NEP-141 receiver. USDC sent here with `msg` of `deposit` (or empty)
    /// lands in the sender's internal balance. Anything else is handed back by
    /// returning the full amount, so a stray token can never pollute the
    /// balance measurements that settle trades.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        let token_id = env::predecessor_account_id();
        if token_id != self.usdc_id {
            env::log_str("refused: WinCut only accepts USDC deposits");
            return PromiseOrValue::Value(amount);
        }
        if !(msg.is_empty() || msg == "deposit") {
            env::log_str("refused: unrecognised msg, expected \"deposit\"");
            return PromiseOrValue::Value(amount);
        }
        if self.paused {
            env::log_str("refused: WinCut is paused");
            return PromiseOrValue::Value(amount);
        }
        require!(amount.0 > 0, "nothing to deposit");

        self.credit_balance(&sender_id, amount.0);
        events::deposit(&sender_id, amount.0, self.balance_of_internal(&sender_id));
        PromiseOrValue::Value(U128(0))
    }

    /// Sends USDC from the caller's internal balance back to their wallet.
    ///
    /// Takes the global lock: the outbound transfer changes the USDC balance
    /// that a sell settlement measures, so the two cannot overlap.
    #[payable]
    pub fn withdraw(&mut self, amount: U128) -> PromiseOrValue<bool> {
        near_sdk::assert_one_yocto();
        let user = env::predecessor_account_id();
        require!(amount.0 > 0, "nothing to withdraw");
        self.assert_unlocked();
        self.debit_balance(&user, amount.0);
        self.take_payout_lock(&user, amount.0);

        PromiseOrValue::Promise(
            ext_ft::ext(self.usdc_id.clone())
                .with_attached_deposit(ONE_YOCTO)
                .with_static_gas(GAS_FT_TRANSFER)
                .ft_transfer(user.clone(), amount, Some("WinCut withdrawal".to_string()))
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(GAS_ON_OUTFLOW)
                        .on_payout_settled(user, amount, false),
                ),
        )
    }

    /// Pays out everything the caller has earned as a copied trader, a referrer
    /// or the protocol. Pull-based, so a settlement is never blocked by one
    /// recipient's account being unable to receive USDC.
    #[payable]
    pub fn claim(&mut self) -> PromiseOrValue<bool> {
        near_sdk::assert_one_yocto();
        let user = env::predecessor_account_id();
        let amount = self.claimable.get(&user).copied().unwrap_or(0);
        require!(amount > 0, "nothing to claim");
        self.assert_unlocked();

        self.claimable.remove(&user);
        self.usdc_accounted -= amount;
        self.take_payout_lock(&user, amount);

        PromiseOrValue::Promise(
            ext_ft::ext(self.usdc_id.clone())
                .with_attached_deposit(ONE_YOCTO)
                .with_static_gas(GAS_FT_TRANSFER)
                .ft_transfer(
                    user.clone(),
                    U128(amount),
                    Some("WinCut earnings".to_string()),
                )
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(GAS_ON_OUTFLOW)
                        .on_payout_settled(user, U128(amount), true),
                ),
        )
    }

    /// Puts the USDC back where it came from if the transfer bounced - which is
    /// what happens when the recipient has no NEP-145 storage on USDC.
    #[private]
    pub fn on_payout_settled(
        &mut self,
        user: AccountId,
        amount: U128,
        was_claim: bool,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> bool {
        self.release_lock(LockKind::Payout);
        match result {
            Ok(()) => {
                if was_claim {
                    events::claim(&user, amount.0);
                } else {
                    events::withdraw(&user, amount.0, self.balance_of_internal(&user));
                }
                true
            }
            Err(_) => {
                if was_claim {
                    self.credit_claimable(&user, amount.0);
                } else {
                    self.credit_balance(&user, amount.0);
                }
                env::log_str(&format!(
                    "payout of {} USDC units to {} bounced and was restored - register on the USDC token first",
                    amount.0, user
                ));
                false
            }
        }
    }
}

impl WinCut {
    pub(crate) fn take_payout_lock(&mut self, user: &AccountId, amount: u128) {
        self.lock = Some(SwapLock {
            user: user.clone(),
            token_id: self.usdc_id.clone(),
            kind: LockKind::Payout,
            amount_in: U128(amount),
            position_amount_before: U128(0),
            cost_basis_before: U128(0),
            min_out: U128(0),
            followed: None,
            referrer: None,
            started_at: env::block_timestamp(),
        });
    }

    /// Clears the lock, tolerating the case where a stale-lock release already
    /// took it, so a callback can never panic on the way out.
    pub(crate) fn release_lock(&mut self, expected: LockKind) {
        match &self.lock {
            Some(lock) if lock.kind == expected => self.lock = None,
            Some(lock) => env::log_str(&format!(
                "warning: expected a {:?} lock but found {:?}; leaving it alone",
                expected, lock.kind
            )),
            None => {}
        }
    }
}
