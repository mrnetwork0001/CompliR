// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";

import {AttestationRegistry} from "../src/AttestationRegistry.sol";
import {GuardedTreasury} from "../src/examples/GuardedTreasury.sol";

/// @title Deploy — AttestationRegistry
/// @notice Reads `OWNER_ADDRESS` (cold admin key) and `ATTESTER_ADDRESS` (hot CompliR service key)
///         from the environment. The broadcaster (`--private-key` / `--account`) only pays gas; it does
///         not need to be either role.
///
///         forge script script/Deploy.s.sol:Deploy --rpc-url $ARC_RPC_URL --private-key $PRIVATE_KEY --broadcast
contract Deploy is Script {
    function run() external returns (AttestationRegistry registry) {
        address owner = vm.envAddress("OWNER_ADDRESS");
        address attester = vm.envAddress("ATTESTER_ADDRESS");
        require(owner != address(0), "Deploy: OWNER_ADDRESS is zero");
        require(attester != address(0), "Deploy: ATTESTER_ADDRESS is zero");

        console.log("chainId  :", block.chainid);
        console.log("owner    :", owner);
        console.log("attester :", attester);

        vm.startBroadcast();
        registry = new AttestationRegistry(owner, attester);
        vm.stopBroadcast();

        console.log("AttestationRegistry:", address(registry));
        console.log("domainSeparator    :");
        console.logBytes32(registry.domainSeparator());
        console.log("ATTESTATION_TYPEHASH:");
        console.logBytes32(registry.ATTESTATION_TYPEHASH());
    }
}

/// @title DeployGuardedTreasury — example integrator
/// @notice Reads `REGISTRY_ADDRESS` (an AttestationRegistry), `TOKEN_ADDRESS` (the ERC-20 to hold, e.g.
///         USDC on Arc) and `OWNER_ADDRESS` (who may call `release`).
///
///         forge script script/Deploy.s.sol:DeployGuardedTreasury --rpc-url $ARC_RPC_URL --private-key $PRIVATE_KEY --broadcast
contract DeployGuardedTreasury is Script {
    function run() external returns (GuardedTreasury treasury) {
        address registry = vm.envAddress("REGISTRY_ADDRESS");
        address token = vm.envAddress("TOKEN_ADDRESS");
        address owner = vm.envAddress("OWNER_ADDRESS");
        require(registry != address(0), "Deploy: REGISTRY_ADDRESS is zero");
        require(token != address(0), "Deploy: TOKEN_ADDRESS is zero");
        require(owner != address(0), "Deploy: OWNER_ADDRESS is zero");
        require(registry.code.length != 0, "Deploy: REGISTRY_ADDRESS has no code on this chain");

        vm.startBroadcast();
        treasury = new GuardedTreasury(registry, token, owner);
        vm.stopBroadcast();

        console.log("GuardedTreasury:", address(treasury));
    }
}
