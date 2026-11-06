// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Stands in for Arc USDC. 6 decimals, matching the ERC-20 interface at
///         0x3600...0000. If the live pools turn out to use NATIVE USDC (18dp),
///         the hook is deployed with QUOTE = address(0) instead and the same
///         tests apply; only this mock changes.
contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
