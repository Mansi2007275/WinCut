// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IMsgSender} from "@uniswap/v4-periphery/src/interfaces/IMsgSender.sol";

/// @notice PHASE 0. Run this against a fork of the target chain BEFORE building.
///         It answers the two questions the whole architecture rests on.
///
///   1. Does the deployed Universal Router expose msgSender()?
///      If not, the hook can never identify the trader and attribution needs a
///      different design (your own router).
///
///   2. Is the v4 PoolManager actually at the address you think, and is USDC
///      native (address(0), 18dp) or the ERC-20 interface (0x3600..., 6dp)?
///      Getting this wrong is a 1e12 accounting error.
///
/// Usage:
///   forge script script/Phase0.s.sol --fork-url $ARC_RPC -vv
contract Phase0 is Script {
    address constant ARC_POOL_MANAGER_EXPECTED = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant ARC_USDC_ERC20 = 0x3600000000000000000000000000000000000000;

    function run() external view {
        console.log("=== PHASE 0: Arc environment checks ===");
        console.log("chain id:", block.chainid);
        console.log("");

        // ---- check 1: PoolManager bytecode present -------------------------
        address pmEnv = vm.envOr("POOL_MANAGER", ARC_POOL_MANAGER_EXPECTED);
        uint256 pmSize = pmEnv.code.length;
        console.log("[1] PoolManager", pmEnv);
        console.log("    bytecode size:", pmSize);
        if (pmSize == 0) {
            console.log("    >>> FAIL: nothing deployed here. Wrong chain or wrong address.");
        } else {
            console.log("    >>> OK: v4 PoolManager is live on this chain.");
        }
        console.log("");

        // ---- check 2: USDC representation ----------------------------------
        uint256 usdcSize = ARC_USDC_ERC20.code.length;
        console.log("[2] USDC ERC-20 interface", ARC_USDC_ERC20);
        console.log("    bytecode size:", usdcSize);
        if (usdcSize > 0) {
            (bool ok, bytes memory ret) =
                ARC_USDC_ERC20.staticcall(abi.encodeWithSignature("decimals()"));
            if (ok && ret.length >= 32) {
                console.log("    decimals:", abi.decode(ret, (uint8)));
                console.log("    >>> ERC-20 interface exists. Expect 6 decimals here.");
            }
        } else {
            console.log("    >>> no ERC-20 interface. QUOTE must be NATIVE address(0), 18 decimals.");
        }
        console.log("    NOTE: a pool can pair against EITHER. Read a real pool's");
        console.log("    PoolKey before pinning QUOTE. Do not assume.");
        console.log("");

        // ---- check 3: msgSender() on the router ----------------------------
        address router = vm.envOr("UNIVERSAL_ROUTER", address(0));
        console.log("[3] Universal Router", router);
        if (router == address(0)) {
            console.log("    >>> SKIPPED: set UNIVERSAL_ROUTER to test.");
        } else if (router.code.length == 0) {
            console.log("    >>> FAIL: no bytecode at this address.");
        } else {
            (bool ok, bytes memory ret) =
                router.staticcall(abi.encodeWithSelector(IMsgSender.msgSender.selector));
            if (ok && ret.length >= 32) {
                console.log("    msgSender() returned:", abi.decode(ret, (address)));
                console.log("    >>> OK: the function EXISTS and is publicly callable.");
                console.log("    (outside an unlock it returns address(0) or stale data;");
                console.log("     what matters is that the call does not revert)");
            } else {
                console.log("    >>> FAIL: msgSender() missing or reverting.");
                console.log("    >>> Attribution via Universal Router will NOT work.");
                console.log("    >>> You need your own router contract that implements IMsgSender.");
            }
        }
        console.log("");
        console.log("=== end phase 0 ===");
    }
}
