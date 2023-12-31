import * as anchor from "@coral-xyz/anchor";
import NodeWallet from "@coral-xyz/anchor/dist/cjs/nodewallet";
import { IDL } from "../target/types/anchor_game";
import {
  PublicKey,
  SystemProgram,
  Connection,
  Commitment,
  TransactionMessage,
  VersionedTransaction,
  Keypair,
  sendAndConfirmTransaction
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
  getMinimumBalanceForRentExemptMint,
  MintLayout,
  createInitializeMintInstruction,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
} from "@solana/spl-token";
import { assert } from "chai";
import { BN } from "bn.js";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";

describe("anchor_game", async () => {

  const stakeHouseIdentifier = `test`;
  const commitment: Commitment = "processed";
  const connection = new Connection("http://localhost:8899", {
    commitment,
    wsEndpoint: "ws://localhost:8900/",
  });

  const options = anchor.AnchorProvider.defaultOptions();
  const wallet = NodeWallet.local();
  const provider = new anchor.AnchorProvider(connection, wallet, options);

  anchor.setProvider(provider);

  const programId = new PublicKey("GrXPDYpqBzn4v6k399oWkph4qxB2YGbgCwa1Wgko1yKh");
  const program = new anchor.Program(IDL, programId, provider);

  let mintA = null as PublicKey;
  let mintB = null as PublicKey;
  let initializerTokenAccountA = null as PublicKey;
  let initializerTokenAccountB = null as PublicKey;
  let takerTokenAccountA = null as PublicKey;
  let takerTokenAccountB = null as PublicKey;

  const takerAmount = 1000;
  const initializerAmount = 500;

  const payer = Keypair.fromSecretKey(bs58.decode("Bhao6w2hvn5LtBgJ6nAno3qTy6WMyn59k7sdbFdJVsRapumSJfF86hZ1wcWJ6SxuEhuJUwC2DoNu5YTA9DyMFSy"))
  //const payer = anchor.web3.Keypair.generate();
  const mintAuthority = anchor.web3.Keypair.generate();
  const initializer = anchor.web3.Keypair.generate();
  const taker = anchor.web3.Keypair.generate();

  const escrowStateId = PublicKey.findProgramAddressSync(
    [
      anchor.utils.bytes.utf8.encode("state"),
      anchor.utils.bytes.utf8.encode(stakeHouseIdentifier)
    ],
    program.programId
  )[0];

  const vaultAuthorityId = PublicKey.findProgramAddressSync(
    [anchor.utils.bytes.utf8.encode("authority")],
    program.programId
  )[0];
  let vaultKey = null as PublicKey;


  it("Initialize program state", async () => {
    const signature = await provider.connection.requestAirdrop(payer.publicKey, 1000000000);
    const latestBlockhash = await connection.getLatestBlockhash();
    await provider.connection.confirmTransaction(
      {
        signature,
        ...latestBlockhash,
      },
      commitment
    );

    const fundingTxMessageV0 = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions: [
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: initializer.publicKey,
          lamports: 100000000,
        }),
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: taker.publicKey,
          lamports: 100000000,
        }),
      ],
    }).compileToV0Message();
    const fundingTx = new VersionedTransaction(fundingTxMessageV0);
    fundingTx.sign([payer]);

    const result = await connection.sendRawTransaction(fundingTx.serialize());

    mintA = await createMint(connection, payer, mintAuthority.publicKey, null, 0);
    mintB = await createMint(provider.connection, payer, mintAuthority.publicKey, null, 0);

    initializerTokenAccountA = await createAccount(connection, initializer, mintA, initializer.publicKey);
    initializerTokenAccountB = await createAccount(connection, initializer, mintB, initializer.publicKey);
    takerTokenAccountA = await createAccount(connection, taker, mintA, taker.publicKey);
    takerTokenAccountB = await createAccount(connection, taker, mintB, taker.publicKey);

    // to initializer token account A & taker token account B
    await mintTo(connection, initializer, mintA, initializerTokenAccountA, mintAuthority, initializerAmount);
    await mintTo(connection, taker, mintB, takerTokenAccountB, mintAuthority, takerAmount);

    const fetchedInitializerTokenAccountA = await getAccount(connection, initializerTokenAccountA);
    const fetchedTakerTokenAccountB = await getAccount(connection, takerTokenAccountB);

    assert.ok(Number(fetchedInitializerTokenAccountA.amount) == initializerAmount);
    assert.ok(Number(fetchedTakerTokenAccountB.amount) == takerAmount);

    // console.log("token account A : ",initializerTokenAccountA)
    // console.log("fetch : ",fetchedInitializerTokenAccountA.address)
  });

  it("Initialize escrow", async () => {

    const nftMint = new PublicKey("DskQgewLBTmPBZwWAZ5U7swcPeggpZ5eRbb6gurY1oZd");
    const _vaultKey = PublicKey.findProgramAddressSync(
      [vaultAuthorityId.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mintA.toBuffer()],
      ASSOCIATED_TOKEN_PROGRAM_ID
    )[0];
    vaultKey = _vaultKey;

    const result = await program.methods
      .initRoom({
        initializerAmount: new anchor.BN(50),//new anchor.BN(initializerAmount),
        takerAmount: new anchor.BN(70),//new anchor.BN(takerAmount),
        identifier: stakeHouseIdentifier,
      })
      .accounts({
        initializer: initializer.publicKey,
        vaultAuthority: vaultAuthorityId,
        vault: vaultKey,
        mint: mintA,
        initializerDepositTokenAccount: initializerTokenAccountA,
        initializerReceiveTokenAccount: initializerTokenAccountB,
        roomState: escrowStateId,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([initializer])
      .rpc();

    let fetchedVault = await getAccount(connection, vaultKey);
    let fetchedEscrowState = await program.account.roomState.fetch(escrowStateId);

    assert.ok(fetchedVault.owner.equals(vaultAuthorityId));

    assert.ok(fetchedEscrowState.initializerKey.equals(initializer.publicKey));
    // assert.ok(fetchedEscrowState.initializerAmount.toNumber() == initializerAmount);
    // assert.ok(fetchedEscrowState.takerAmount.toNumber() == takerAmount);
    assert.ok(fetchedEscrowState.initializerDepositTokenAccount.equals(initializerTokenAccountA));
    assert.ok(fetchedEscrowState.initializerReceiveTokenAccount.equals(initializerTokenAccountB));

    console.log('------------------after player init------------------')
    console.log("expect player token A to room :",fetchedEscrowState.initializerAmount.toNumber())
    console.log("expect taker token B to player :",fetchedEscrowState.takerAmount.toNumber())
    //console.log(fetchedEscrowState)

  });

  // it("Exchange", async () => {

  //   const result = await program.methods
  //     .exchange()
  //     .accounts({
  //       taker: taker.publicKey,
  //       initializerDepositTokenMint: mintA,
  //       takerDepositTokenMint: mintB,
  //       takerDepositTokenAccount: takerTokenAccountB,
  //       takerReceiveTokenAccount: takerTokenAccountA,
  //       initializerDepositTokenAccount: initializerTokenAccountA,
  //       initializerReceiveTokenAccount: initializerTokenAccountB,
  //       initializer: initializer.publicKey,
  //       roomState: escrowStateId,
  //       vault: vaultKey,
  //       vaultAuthority: vaultAuthorityId,
  //       tokenProgram: TOKEN_PROGRAM_ID,
  //     })
  //     .signers([taker])
  //     .rpc();
      
  //   let fetchedInitializerTokenAccountA = await getAccount(connection, initializerTokenAccountA);
  //   let fetchedInitializerTokenAccountB = await getAccount(connection, initializerTokenAccountB);
  //   let fetchedTakerTokenAccountA = await getAccount(connection, takerTokenAccountA);
  //   let fetchedTakerTokenAccountB = await getAccount(connection, takerTokenAccountB);

  //   // assert.ok(Number(fetchedTakerTokenAccountA.amount) == initializerAmount);
  //   // assert.ok(Number(fetchedInitializerTokenAccountA.amount) == 0);
  //   // assert.ok(Number(fetchedInitializerTokenAccountB.amount) == takerAmount);
  //   // assert.ok(Number(fetchedTakerTokenAccountB.amount) == 0);
    
  //   console.log('------------------after taker exchange------------------')
  //   console.log('player token A :',fetchedInitializerTokenAccountA.amount)
  //   console.log('player token B :',fetchedInitializerTokenAccountB.amount)
  //   console.log('taker token A :',fetchedTakerTokenAccountA.amount)
  //   console.log('taker token B :',fetchedTakerTokenAccountB.amount)
  // })

  it("lose Exchange", async () => {

    const result = await program.methods
      .loser()
      .accounts({
        taker: taker.publicKey,
        initializerDepositTokenMint: mintA,
        takerDepositTokenMint: mintB,
        takerDepositTokenAccount: takerTokenAccountB,
        takerReceiveTokenAccount: takerTokenAccountA,
        initializerDepositTokenAccount: initializerTokenAccountA,
        initializerReceiveTokenAccount: initializerTokenAccountB,
        initializer: initializer.publicKey,
        roomState: escrowStateId,
        vault: vaultKey,
        vaultAuthority: vaultAuthorityId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([taker])
      .rpc();
      
    let fetchedInitializerTokenAccountA = await getAccount(connection, initializerTokenAccountA);
    let fetchedInitializerTokenAccountB = await getAccount(connection, initializerTokenAccountB);
    let fetchedTakerTokenAccountA = await getAccount(connection, takerTokenAccountA);
    let fetchedTakerTokenAccountB = await getAccount(connection, takerTokenAccountB);

    // assert.ok(Number(fetchedTakerTokenAccountA.amount) == initializerAmount);
    // assert.ok(Number(fetchedInitializerTokenAccountA.amount) == 0);
    // assert.ok(Number(fetchedInitializerTokenAccountB.amount) == takerAmount);
    // assert.ok(Number(fetchedTakerTokenAccountB.amount) == 0);
    
    console.log('------------------after taker exchange------------------')
    console.log('player token A :',fetchedInitializerTokenAccountA.amount)
    console.log('player token B :',fetchedInitializerTokenAccountB.amount)
    console.log('taker token A :',fetchedTakerTokenAccountA.amount)
    console.log('taker token B :',fetchedTakerTokenAccountB.amount)
  })

  // it("cancel escrow", async () => {
  //   await mintTo(connection, initializer, mintA, initializerTokenAccountA, mintAuthority, initializerAmount);

  //   const initializedTx = await program.methods
  //     .initRoom({
  //       initializerAmount: new anchor.BN(50),
  //       takerAmount: new anchor.BN(takerAmount),
  //       identifier: stakeHouseIdentifier,
  //     })
  //     .accounts({
  //       initializer: initializer.publicKey,
  //       vaultAuthority: vaultAuthorityId,
  //       vault: vaultKey,
  //       mint: mintA,
  //       initializerDepositTokenAccount: initializerTokenAccountA,
  //       initializerReceiveTokenAccount: initializerTokenAccountB,
  //       roomState: escrowStateId,
  //       systemProgram: anchor.web3.SystemProgram.programId,
  //       // rent: anchor.web3.SYSVAR_RENT_PUBKEY,
  //       tokenProgram: TOKEN_PROGRAM_ID,
  //     })
  //     .signers([initializer])
  //     .rpc();
  //   const fetchedInitializerTokenAccountA_before = await getAccount(connection, initializerTokenAccountA);
  //   let fetchedEscrowState = await program.account.roomState.fetch(escrowStateId);
  //   console.log('---------------before cancel---------------')
  //   console.log('initializer token A :',fetchedInitializerTokenAccountA_before.amount)
  //   console.log('escrow A token:', fetchedEscrowState.initializerAmount.toNumber())

  //   const canceledTX = await program.methods
  //     .cancel()
  //     .accounts({
  //       initializer: initializer.publicKey,
  //       mint: mintA,
  //       initializerDepositTokenAccount: initializerTokenAccountA,
  //       vault: vaultKey,
  //       vaultAuthority: vaultAuthorityId,
  //       roomState: escrowStateId,
  //       tokenProgram: TOKEN_PROGRAM_ID,
  //     })
  //     .signers([initializer])
  //     .rpc();

  //   const fetchedInitializerTokenAccountA = await getAccount(connection, initializerTokenAccountA);

  //   assert.ok(fetchedInitializerTokenAccountA.owner.equals(initializer.publicKey));
  //   // assert.ok(Number(fetchedInitializerTokenAccountA.amount) == initializerAmount);

  //   console.log('---------------after cancel---------------')
  //   console.log('initializer token A :',fetchedInitializerTokenAccountA.amount)
  // })

});
