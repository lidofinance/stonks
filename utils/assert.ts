const defaultDelta = 4n

export const isClose = function (actual: bigint, expected: bigint, delta: bigint = defaultDelta) {
  const diff = Math.abs(Number(actual - expected))

  return diff <= delta && diff >= 0
}
