import { GPv2Order } from "../../typechain-types/contracts/interfaces/ICoWSwapOnchainOrders";

type OrderData = Omit<GPv2Order.DataStruct, "kind" | "appData" | "sellTokenBalance" | "buyTokenBalance">;

export const createOrderData = ({
    sellToken,
    buyToken,
    receiver,
    sellAmount,
    buyAmount,
    validTo,
    feeAmount,
    partiallyFillable = false,
}: OrderData): GPv2Order.DataStruct => {
    return {
        sellToken,
        buyToken,
        receiver,
        sellAmount,
        buyAmount,
        validTo,
        appData: "0x4c18f74b65f5527cfdc4ce73006140f88db327a47476b2c358c7e8f92621fa19", // keccak256("LIDO_SWAP_ORDER"),
        feeAmount,
        kind: "0xf3b277728b3fee749481eb3e0b3b48980dbbab78658fc419025cb16eee346775",
        partiallyFillable,
        sellTokenBalance: "0x5a28e9363bb942b639270062aa6bb295f434bcdfc42c97267bf003f272060dc9",
        buyTokenBalance: "0x5a28e9363bb942b639270062aa6bb295f434bcdfc42c97267bf003f272060dc9"
    }
}

export const orderDataMock = createOrderData({
    sellToken: "",
    buyToken: "",
    receiver: "",
    sellAmount: "0",
    buyAmount: "0",
    validTo: "0",
    feeAmount: "0",
    partiallyFillable: false
})
