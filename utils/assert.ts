const delta = 5

export const isClose = function (actual: bigint, expected: bigint) {
  const diff = Math.abs(Number(actual - expected))

  return diff <= delta && diff >= 0
}
