pragma solidity ^0.7.0;

contract Greeter {
    string public name;

    constructor(string memory _name) {
        name = _name;
    }

    function greet() public view returns (string memory) {
        return name;
    }
}
