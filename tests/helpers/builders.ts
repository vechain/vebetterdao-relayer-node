import type { NetworkConfig, LogFn } from "../../src/types"

export const ZERO = "0x0000000000000000000000000000000000000000"

export function addr(seed: string | number): string {
  const s = typeof seed === "number" ? seed.toString(16) : seed
  return "0x" + s.padStart(40, "0")
}

export function bytes32(seed: string | number): string {
  const s = typeof seed === "number" ? seed.toString(16) : seed
  return "0x" + s.padStart(64, "0")
}

export function makeConfig(overrides: Partial<NetworkConfig> = {}): NetworkConfig {
  return {
    name: "test",
    nodeUrl: "http://localhost:8669",
    xAllocationVotingAddress: addr("a110ca7100"),
    voterRewardsAddress: addr("70e7e7"),
    relayerRewardsPoolAddress: addr("700107"),
    xAllocationPoolAddress: addr("90017"),
    b3trGovernorAddress: addr("90763"),
    navigatorRegistryAddress: addr("9a71"),
    ...overrides,
  }
}

export function captureLogs(): { log: LogFn; lines: string[] } {
  const lines: string[] = []
  return {
    log: (msg: string) => {
      lines.push(msg)
    },
    lines,
  }
}
