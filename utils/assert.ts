const defaultDelta = 4n

export const isClose = function (actual: bigint, expected: bigint, delta: bigint = defaultDelta) {
  const diff = actual > expected ? actual - expected : expected - actual

  return diff <= delta
}
