process.env.ARC_CHAIN_ID = "5042";
process.env.ARC_RPC_URL = "https://rpc.example.invalid";
process.env.USDC_ADDRESS = "0x0000000000000000000000000000000000000001";
process.env.DATABASE_URL = ":memory:";
process.env.X402_DISABLED = "1";
process.env.COMPLIR_PAUSED = "0";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.REGISTRY_ADDRESS;
delete process.env.ATTESTER_PRIVATE_KEY;
