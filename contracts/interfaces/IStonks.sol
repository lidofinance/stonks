// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IStonks {
    struct OrderParameters {
        address tokenFrom;
        address tokenTo;
        address tokenAmountConverter;
        uint64 orderDurationInSeconds;
        uint16 marginInBasisPoints;
        uint16 priceToleranceInBasisPoints;
    }

    function getOrderParameters() external view returns (OrderParameters memory);
}
