# Frequently Asked Questions

## General

### What is Fibernuts?
Fibernuts is a Cashu mint backend that settles over Fiber Network, enabling instant private payments with RUSD stablecoin.

### What is RUSD?
RUSD is a stablecoin on the Nervos CKB blockchain issued by Stable++.

### Is this production-ready?
The protocol implementation is under active development. The reference deployment is testnet-only
and has not received a formal security audit. Use at your own risk.

## Technical

### What's the minimum RUSD needed?
You need at least 10 RUSD to open a channel to the public mint.

### How long does channel opening take?
Typically 2-5 minutes for the funding transaction to confirm on CKB testnet.

### Can I close my channel?
Yes, you can close channels using the Fiber node commands.

## Troubleshooting

### My node can't see my funds
Make sure transactions are confirmed on-chain. Check the CKB explorer.

### Channel stuck in AwaitingTxSignatures
Wait for the funding transaction to confirm. This takes a few minutes.

### Payment failed
Ensure your channel is in ChannelReady state and has sufficient balance.
