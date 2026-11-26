// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IPoolData {
    function getUserAccountData(address user)
        external
        view
        returns (uint256, uint256, uint256, uint256, uint256, uint256);
}

/// Test run helper (M0-4, D-15). Never deployed: its runtime code is put at the Safe's address by an
/// `eth_call` state override, so `address(this)` is the Safe and Aave sees the Safe as the caller.
/// It runs the batch one call at a time (so the failing step is known), then reads the Aave account
/// in the same call.
contract TestRunHelper {
    struct Result {
        bool ok;
        uint256 failedStep; // index of the failing call; type(uint256).max when ok
        bytes revertData; // revert data of the failing call
        uint256 totalCollateralBase;
        uint256 totalDebtBase;
        uint256 healthFactor;
        uint256 gasUsed; // gas of the calls themselves, not of the Safe's execTransaction
    }

    function simulate(address pool, address[] calldata targets, uint256[] calldata values, bytes[] calldata datas)
        external
        returns (Result memory r)
    {
        uint256 g = gasleft();
        r.failedStep = type(uint256).max;
        for (uint256 i = 0; i < targets.length; i++) {
            (bool ok, bytes memory ret) = targets[i].call{value: values[i]}(datas[i]);
            if (!ok) {
                r.failedStep = i;
                r.revertData = ret;
                r.gasUsed = g - gasleft();
                return r;
            }
        }
        r.gasUsed = g - gasleft();
        r.ok = true;
        (r.totalCollateralBase, r.totalDebtBase,,,, r.healthFactor) = IPoolData(pool).getUserAccountData(address(this));
    }
}
