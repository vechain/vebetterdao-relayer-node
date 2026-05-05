import { NetworkConfig } from "./types"

export const MAINNET_NODES = [
  "https://mainnet.vechain.org",
  "https://vethor-node.vechain.com",
  "https://node-mainnet.vechain.energy",
  "https://mainnet.vecha.in",
]

export const TESTNET_NODES = [
  "https://testnet.vechain.org",
]

export const SOLO_DEFAULT_URL = "http://localhost:8669"

export const MAINNET: NetworkConfig = {
  name: "mainnet",
  nodeUrl: MAINNET_NODES[0],
  xAllocationVotingAddress: "0x89A00Bb0947a30FF95BEeF77a66AEdE3842Fe5B7",
  voterRewardsAddress: "0x838A33AF756a6366f93e201423E1425f67eC0Fa7",
  relayerRewardsPoolAddress: "0x34b56f892c9e977b9ba2e43ba64c27d368ab3c86",
  xAllocationPoolAddress: "0x4191776F05f4bE4848d3f4d587345078B439C7d3",
  b3trGovernorAddress: "0x1c65C25fABe2fc1bCb82f253fA0C916a322f777C",
  navigatorRegistryAddress: "0xef238e33fc78ecc79beaf8386254a0fc67d048e0",
}

export const TESTNET_STAGING: NetworkConfig = {
  name: "testnet-staging",
  nodeUrl: TESTNET_NODES[0],
  xAllocationVotingAddress: "0x8800592c463f0b21ae08732559ee8e146db1d7b2",
  voterRewardsAddress: "0x851ef91801899a4e7e4a3174a9300b3e20c957e8",
  relayerRewardsPoolAddress: "0x92b5a7484970d9b2ad981e8135ff14e6f996dc04",
  xAllocationPoolAddress: "0x6f7b4bc19b4dc99005b473b9c45ce2815bbe7533",
  b3trGovernorAddress: "0xc30b4d0837f7e3706749655d8bde0c0f265dd81b",
  navigatorRegistryAddress: "0x15a38b65f26bdbca50addf3865732613a45bbc00",
}

function getSoloConfig(): NetworkConfig {
  const required = (key: string): string => {
    const val = process.env[key]?.trim()
    if (!val) throw new Error(`Solo network requires ${key} env var`)
    return val
  }
  return {
    name: "solo",
    nodeUrl: process.env.NODE_URL?.trim() || SOLO_DEFAULT_URL,
    xAllocationVotingAddress: required("X_ALLOCATION_VOTING_ADDRESS"),
    voterRewardsAddress: required("VOTER_REWARDS_ADDRESS"),
    relayerRewardsPoolAddress: required("RELAYER_REWARDS_POOL_ADDRESS"),
    xAllocationPoolAddress: required("X_ALLOCATION_POOL_ADDRESS"),
    b3trGovernorAddress: required("B3TR_GOVERNOR_ADDRESS"),
    navigatorRegistryAddress: required("NAVIGATOR_REGISTRY_ADDRESS"),
  }
}

export function getNetworkConfig(network: string, nodeUrlOverride?: string): NetworkConfig {
  let config: NetworkConfig
  switch (network) {
    case "mainnet":
      config = { ...MAINNET }
      break
    case "solo":
      config = getSoloConfig()
      break
    case "testnet-staging":
    default:
      config = { ...TESTNET_STAGING }
      break
  }
  if (nodeUrlOverride) config.nodeUrl = nodeUrlOverride
  return config
}

export function getNodePool(network: string): string[] {
  switch (network) {
    case "mainnet":
      return [...MAINNET_NODES]
    case "solo":
      return [process.env.NODE_URL?.trim() || SOLO_DEFAULT_URL]
    case "testnet-staging":
    default:
      return [...TESTNET_NODES]
  }
}
