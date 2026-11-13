// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title  WinCutCoin
/// @notice A deliberately boring memecoin: fixed supply, no mint, no owner,
///         no transfer tax, no pause, no blocklist.
/// @dev    Nothing here can rug. The entire supply is minted once at construction
///         and the contract has no privileged functions at all. Sell taxes are
///         exactly what WinCut does NOT do, so the coin must not have one either.
contract WinCutCoin is ERC20 {
    string public metadataURI;
    address public immutable creator;

    constructor(string memory name_, string memory symbol_, string memory metadataURI_, uint256 supply, address creator_)
        ERC20(name_, symbol_)
    {
        metadataURI = metadataURI_;
        creator = creator_;
        _mint(msg.sender, supply); // to the launcher, which seeds the pool
    }
}
