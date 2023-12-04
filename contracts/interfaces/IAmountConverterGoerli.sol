// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

interface IAmountConverterGoerli {
    function getExpectedOut(uint256 amount, address sellToken, address buyToken, bytes calldata)
        external
        view
        returns (uint256);
}
