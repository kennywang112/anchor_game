use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, TransferChecked};
use crate::RoomState;

#[derive(Accounts)]
pub struct LoseExchange<'info> {
    /// CHECK: This is not dangerous because we don't read or write from this account
    pub taker: Signer<'info>,
    pub initializer_deposit_token_mint: Account<'info, Mint>,
    pub taker_deposit_token_mint: Account<'info, Mint>,
    #[account(mut)]
    pub taker_deposit_token_account: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub taker_receive_token_account: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub initializer_deposit_token_account: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub initializer_receive_token_account: Box<Account<'info, TokenAccount>>,
    /// CHECK: This is not dangerous because we don't read or write from this account
    #[account(mut)]
    pub initializer: AccountInfo<'info>,
    #[account(
        mut,
        constraint = room_state.taker_amount <= taker_deposit_token_account.amount,
        constraint = room_state.initializer_deposit_token_account == *initializer_deposit_token_account.to_account_info().key,
        constraint = room_state.initializer_receive_token_account == *initializer_receive_token_account.to_account_info().key,
        constraint = room_state.initializer_key == *initializer.key,

        close = initializer
    )]
    pub room_state: Box<Account<'info, RoomState>>,
    #[account(mut)]
    pub vault: Box<Account<'info, TokenAccount>>,
    /// CHECK: This is not dangerous because we don't read or write from this account
    #[account(
        seeds = [b"authority".as_ref()],
        bump,
    )]
    pub vault_authority: AccountInfo<'info>,
    /// CHECK: This is not dangerous because we don't read or write from this account
    pub token_program: Program<'info, Token>,
}

impl<'info> LoseExchange<'info> {

    fn into_transfer_to_initializer_context(
        &self,
    ) -> CpiContext<'_, '_, '_, 'info, TransferChecked<'info>> {
        let cpi_accounts = TransferChecked {
            from: self.taker_deposit_token_account.to_account_info(),
            mint: self.taker_deposit_token_mint.to_account_info(),
            to: self.initializer_receive_token_account.to_account_info(),
            authority: self.taker.to_account_info(),
        };
        CpiContext::new(self.token_program.to_account_info(), cpi_accounts)
    }

    fn into_transfer_to_taker_context(
        &self,
    ) -> CpiContext<'_, '_, '_, 'info, TransferChecked<'info>> {
        let cpi_accounts = TransferChecked {
            from: self.vault.to_account_info(),
            mint: self.initializer_deposit_token_mint.to_account_info(),
            to: self.taker_receive_token_account.to_account_info(),
            authority: self.vault_authority.clone(),
        };
        CpiContext::new(self.token_program.to_account_info(), cpi_accounts)
    }

    fn into_close_context(&self) -> CpiContext<'_, '_, '_, 'info, CloseAccount<'info>> {
        let cpi_accounts = CloseAccount {
            account: self.vault.to_account_info(),
            destination: self.initializer.clone(),
            authority: self.vault_authority.clone(),
        };
        CpiContext::new(self.token_program.to_account_info(), cpi_accounts)
    }
}

pub fn handler(
    ctx: Context<LoseExchange>
) -> Result<()> {

    const AUTHORITY_SEED: &[u8] = b"authority";
    
    let authority_seeds = &[
        &AUTHORITY_SEED[..],
        &[ctx.accounts.room_state.vault_authority_bump],
    ];

    //from taker to player
    token::transfer_checked(
        ctx.accounts.into_transfer_to_initializer_context(),
        ctx.accounts.room_state.taker_amount.checked_div(2).unwrap(),
        ctx.accounts.taker_deposit_token_mint.decimals,
    )?;

    //from vault to taker
    token::transfer_checked(
        ctx.accounts.into_transfer_to_taker_context().with_signer(&[&authority_seeds[..]]),
        ctx.accounts.room_state.initializer_amount,
        ctx.accounts.initializer_deposit_token_mint.decimals,
    )?;

    token::close_account(
        ctx.accounts
            .into_close_context()
            .with_signer(&[&authority_seeds[..]]),
    )?;

    Ok(())
}