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

export const MAINNET: NetworkConfig = {
  name: "mainnet",
  nodeUrl: MAINNET_NODES[0],
  xAllocationVotingAddress: "0x89A00Bb0947a30FF95BEeF77a66AEdE3842Fe5B7",
  voterRewardsAddress: "0x838A33AF756a6366f93e201423E1425f67eC0Fa7",
  relayerRewardsPoolAddress: "0x34b56f892c9e977b9ba2e43ba64c27d368ab3c86",
  xAllocationPoolAddress: "0x4191776F05f4bE4848d3f4d587345078B439C7d3",
}

export const TESTNET_STAGING: NetworkConfig = {
  name: "testnet-staging",
  nodeUrl: TESTNET_NODES[0],
  xAllocationVotingAddress: "0x8800592c463f0b21ae08732559ee8e146db1d7b2",
  voterRewardsAddress: "0x851ef91801899a4e7e4a3174a9300b3e20c957e8",
  relayerRewardsPoolAddress: "0x92b5a7484970d9b2ad981e8135ff14e6f996dc04",
  xAllocationPoolAddress: "0x6f7b4bc19b4dc99005b473b9c45ce2815bbe7533",
}

export function getNetworkConfig(network: string, nodeUrlOverride?: string): NetworkConfig {
  let config: NetworkConfig
  switch (network) {
    case "mainnet":
      config = { ...MAINNET }
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
    case "testnet-staging":
    default:
      return [...TESTNET_NODES]
  }
}
