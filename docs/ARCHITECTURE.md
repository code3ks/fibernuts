# Architecture Overview

## System Components

```
┌─────────────┐
│   Wallet    │ (Browser - fibernuts.strawhatcrew.xyz)
└──────┬──────┘
       │ HTTP/HTTPS
       ↓
┌─────────────┐
│  cdk-mintd  │ (Cashu Mint - Rust)
└──────┬──────┘
       │ gRPC
       ↓
┌──────────────────┐
│ fibernuts-processor │ (Payment Backend - Rust)
└──────┬─────────────┘
       │ JSON-RPC
       ↓
┌─────────────┐
│ Fiber Node  │ (Lightning-style Network)
└──────┬──────┘
       │ P2P Protocol
       ↓
┌─────────────┐
│  CKB Chain  │ (Layer 1 Blockchain)
└─────────────┘
```

## Key Features

### cdk-fiber
- Implements `MintPayment` trait from Cashu Development Kit
- Communicates with Fiber node via JSON-RPC
- Handles mint and melt operations
- Manages invoice states

### fibernuts-processor
- gRPC server wrapping cdk-fiber
- Bridges cdk-mintd and Fiber node
- Configurable via environment variables

### Fiber Node
- Manages payment channels
- Routes payments via HTLC-like TLCs
- Settles on CKB blockchain

## Data Flow

### Minting (Deposit)
1. User requests ecash from wallet
2. Mint generates Fiber invoice
3. User pays invoice from their Fiber node
4. Payment settles through channel
5. Mint issues ecash tokens

### Melting (Withdrawal)
1. User provides Fiber invoice to wallet
2. Mint receives ecash tokens
3. Mint pays Fiber invoice
4. Payment routes through network
5. Tokens burned, user receives RUSD
