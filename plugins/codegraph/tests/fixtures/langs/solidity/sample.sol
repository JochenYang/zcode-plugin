// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./IERC20.sol";
import {Ownable} from "./Ownable.sol";

uint256 constant MAX_SUPPLY = 1_000_000;

/** Vault holds tokens for registered users. */
contract Vault is Ownable {
    uint256 public constant FEE_BPS = 25;
    address public immutable token;

    struct Account { uint256 balance; uint64 since; }
    enum Status { Inactive, Active }
    event Deposited(address indexed user, uint256 amount);
    error InsufficientBalance(uint256 requested, uint256 available);

    modifier onlyPositive(uint256 amount) {
        require(amount > 0, "zero amount");
        _;
    }

    constructor(address token_) { token = token_; }

    /** Deposits tokens into the vault. */
    function deposit(uint256 amount) external onlyPositive(amount) returns (bool ok) {
        IERC20(token).transferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, amount);
        return true;
    }

    function balanceOf(address who) external view returns (uint256) {
        return IERC20(token).balanceOf(who);
    }

    function deploy() external returns (Vault v) {
        v = new Vault();
    }
}
