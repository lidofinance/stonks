// Script helps verify that the source files uploaded on Etherscan match the bytecode deployed
// in the blockchain. The main steps of the algorithm are as follows:
//    1. Download the contract's source code from the Etherscan
//    2. Parse the downloaded contract data
//    3. Download the solc compiler version used to compile the contract
//    4. Compile the contract using the downloaded solc and compilation settings from the Etherscan
//    5. Retrieve the bytecode from the blockchain using the RPC node
//    6. Match the bytecode from the Etherscan and blockchain and show the diff if found

import os from 'node:os'
import util from 'node:util'
import path from 'node:path'
import https from 'node:https'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { exec } from 'child_process'
import { createReadStream, createWriteStream } from 'fs'

// ---
// SCRIPT REQUIRED VARIABLES
// ---

const RPC_URL = process.env['RPC_URL'] ?? ''

if (!RPC_URL) {
  throw new Error(`RPC_URL variable is not set`)
}

const ETHERSCAN_API_KEY = process.env['ETHERSCAN_API_KEY'] ?? ''

if (!ETHERSCAN_API_KEY) {
  throw new Error('ETHERSCAN_API_KEY variable is not set')
}

const CONTRACT = process.env['CONTRACT'] ?? ''

if (!CONTRACT) {
  throw new Error('CONTRACT variable is not set')
}

const NETWORK = process.env['NETWORK'] ?? 'mainnet'
const SOLC_DIR = process.env['SOLC_DIR'] ?? 'solc'
const USE_CACHED_SOLC = process.env['CACHE'] === 'false' ? false : true

// ---
// MAIN SCRIPT LOGIC
// ---

interface ImmutableReferences {
  [astNode: string]: { length: number; start: number }[]
}

async function main() {
  console.log(`Verifying the contract "${CONTRACT}" on "${NETWORK}" network\n`)

  console.log(`Downloading the source code from the Etherscan...`)
  const code = await loadEtherscanSourceCode(ETHERSCAN_API_KEY, NETWORK, CONTRACT)

  console.log(`Source code for contract ${code.name} downloaded successfully\n`)

  console.log(
    `Downloading the solc compiler ${code.compiler}. Allowed to use cached version: ${USE_CACHED_SOLC}.`
  )

  const [solcPath, cached] = await downloadSolcCompiler(
    getSolcNativePlatformFromOs(),
    code.compiler.slice(1), // skip leading v prefix
    SOLC_DIR,
    USE_CACHED_SOLC
  )

  if (cached) {
    console.log(`Solc compiler successfully downloaded: ${solcPath}\n`)
  } else {
    console.log(`Solc compiler binary already exist at: ${solcPath}\n`)
  }

  // enable generation of the immutable references for all files
  code.solcInput.settings.outputSelection['*']['*'].push('evm.deployedBytecode.immutableReferences')

  console.log(`Compiling the contracts downloaded from the etherscan...`)

  // TODO: add types for the output. Output format:
  // https://docs.soliditylang.org/en/latest/using-the-compiler.html#output-description
  const compilationResult: any = await compile(solcPath, JSON.stringify(code.solcInput))

  const contractsToCheck = []
  for (const contracts of Object.values<any[]>(compilationResult.contracts)) {
    for (const [name, contract] of Object.entries<any>(contracts)) {
      if (name === code.name) {
        contractsToCheck.push(contract)
      }
    }
  }

  if (contractsToCheck.length !== 1) {
    throw new Error('multiple contracts with same name')
  }

  const contract: any = contractsToCheck[0]

  console.log(`Contracts were successfully compiled. The target contract is ready for matching\n`)

  const expectedBytecode: string = contract.evm.deployedBytecode.object
  const immutableReferences: ImmutableReferences = contract.evm.deployedBytecode.immutableReferences

  // map of immutables refs { startPosition: immutableLength }
  const immutables: Record<number, number> = {}

  for (const refs of Object.values(immutableReferences || {})) {
    for (const ref of refs) {
      immutables[ref.start] = ref.length
    }
  }

  console.log(`Retrieving the bytecode for contract ${CONTRACT} from the blockchain...`)
  const { result: actualBytecode } = JSON.parse(
    await requests.post(RPC_URL, {
      id: 1,
      jsonrpc: '2.0',
      method: 'eth_getCode',
      params: [CONTRACT, 'latest'],
    })
  )
  console.log(`Bytecode was successfully fetched\n`)

  console.log(`Comparing actual code with and expected one:\n`)

  match(actualBytecode, expectedBytecode, immutables)
}

// ---
// CONTRACT INFO RESOLVING VIA ETHERSCAN API
// ---

// contains only the part of the methods required in the script. Full description:
// https://docs.soliditylang.org/en/latest/using-the-compiler.html#input-description
interface SolcInputSlice {
  sources: Record<string, { content: string }>
  settings: {
    outputSelection: Record<string, Record<string, string[]>>
    metadata?: {
      appendCBOR?: boolean
      bytecodeHash?: 'ipfs' | 'none' | 'bzzr1'
    }
  }
}

interface EtherscanError {
  status: '0'
  message: 'NOTOK'
  result: string
}

interface EtherscanSuccess<T> {
  status: '1'
  message: 'OK'
  result: T
}

interface EtherscanSourceCode {
  SourceCode: string
  ABI: string
  ContractName: string
  CompilerVersion: string
  OptimizationUsed: string
  Runs: string
  ConstructorArguments: string
  EVMVersion: string
  Library: string
  LicenseType: string
  Proxy: string
  Implementation: string
  SwarmSource: string
}

interface ContractSourceCode {
  name: string
  compiler: string
  solcInput: SolcInputSlice
}

async function loadEtherscanSourceCode(
  key: string,
  network: string,
  address: string
): Promise<ContractSourceCode> {
  const apiDomain = network === 'mainnet' ? 'api' : `api-${network}`
  const url = [
    `https://${apiDomain}.etherscan.io/api?`,
    'module=contract',
    'action=getsourcecode',
    `address=${address}`,
    `apikey=${key}`,
  ].join('&')
  const response = await requests.getJson<EtherscanError | EtherscanSuccess<EtherscanSourceCode[]>>(
    url
  )
  if (isErrorEtherscanResponse(response)) {
    throw new Error(`Etherscan Request Error: ${response.result}`)
  } else if (isEtherscanSuccessResponse<EtherscanSourceCode[]>(response)) {
    if (response.result.length !== 1) {
      throw new Error(`Unexpected result length: ${JSON.stringify(response.result)}`)
    }
    const result = response.result[0]
    if (result.ABI === 'Contract source code not verified') {
      throw new Error(`Error: ${address} is not verified or not a contract`)
    }
    if (result.CompilerVersion.startsWith('vyper')) {
      throw new Error(`Vyper contracts doesn't supported`)
    }

    let solcInput = response.result[0].SourceCode
    // TODO: handle contracts which were uploaded as single file
    solcInput = solcInput.startsWith('{{') ? solcInput.slice(1, solcInput.length - 1) : solcInput

    return {
      name: result.ContractName,
      solcInput: JSON.parse(solcInput),
      compiler: result.CompilerVersion,
    }
  } else {
    throw new Error(`Unexpected Etherscan response: ${response}`)
  }
}

function isErrorEtherscanResponse(response: unknown): response is EtherscanError {
  return (response as EtherscanError).status === '0'
}

function isEtherscanSuccessResponse<T>(response: unknown): response is EtherscanSuccess<T> {
  return (response as EtherscanSuccess<unknown>).status === '1'
}

// ---
// SOLC COMPILER DOWNLOADING
// ---

type SolcNativePlatform = 'linux-amd64' | 'macosx-amd64'

interface SolcBuild {
  path: string
  version: string
  build: string
  longVersion: string
  keccak256: string
  sha256: string
  urls: string[]
}

interface SolcList {
  builds: SolcBuild[]
  releases: Record<string, string>
}

function getSolcNativePlatformFromOs(): SolcNativePlatform {
  const platform = os.platform()
  switch (os.platform()) {
    case 'linux':
      return 'linux-amd64'
    case 'darwin':
      return 'macosx-amd64'
    default:
      throw new Error(`Unsupported platform ${platform}`)
  }
}

async function downloadSolcCompiler(
  platform: SolcNativePlatform,
  longVersion: string,
  dir: string,
  allowCache = true
): Promise<[path: string, cached: boolean]> {
  const solcListUrl = `https://raw.githubusercontent.com/ethereum/solc-bin/gh-pages/${platform}/list.json`
  const list = await requests.getJson<SolcList>(solcListUrl)
  const build = await list.builds.find((b) => b.longVersion === longVersion)

  if (!build) {
    throw new Error(`Build for solc version "${longVersion}" is not found`)
  }

  const absDirPath = path.resolve(dir)
  if (!(await exists(absDirPath))) {
    await fs.mkdir(absDirPath, { recursive: true })
  }

  const solcFilePath = path.join(dir, build.path)

  if (allowCache && (await exists(solcFilePath))) {
    const sha256Checksum = await checksum(solcFilePath, 'SHA256')
    if (sha256Checksum === build.sha256) {
      return [solcFilePath, true]
    }
  }

  const solcFileUrl = `https://binaries.soliditylang.org/${platform}/${build.path}`
  await requests.download(solcFileUrl, solcFilePath)
  const sha256Checksum = await checksum(solcFilePath, 'SHA256')
  if (sha256Checksum !== build.sha256) {
    throw new Error(
      `Invalid hash of the downloaded solc binaries: expected - ${build.sha256}, actual - ${sha256Checksum}`
    )
  }
  return [solcFilePath, false]
}

async function compile(solcPath: string, settings: string) {
  if (!(await exists(solcPath, fs.constants.X_OK))) {
    const { stderr } = await util.promisify(exec)(`chmod +x ./${solcPath}`)
    if (stderr) {
      throw new Error(stderr)
    }
  }

  const stdout = await new Promise<string>((resolve, reject) => {
    const process = exec(
      `./${solcPath} --standard-json`,
      { maxBuffer: 4096 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(error)
        if (stderr) reject(stderr)
        resolve(stdout)
      }
    )
    process.stdin?.write(settings)
    process.stdin?.end()
  })

  return JSON.parse(stdout)
}

async function exists(p: string, mode = fs.constants.F_OK) {
  try {
    await fs.access(p, mode)
    return true
  } catch {
    return false
  }
}

async function checksum(path: string, algorithm: string) {
  const stream = await createReadStream(path)
  const hash = crypto.createHash(algorithm)
  await new Promise((resolve, reject) => {
    stream.pipe(hash)
    hash.on('finish', resolve)
    hash.once('error', reject)
  })
  return '0x' + hash.digest('hex')
}

// ---
// BYTECODE MATCHING
// ---

interface Instruction {
  op: { name: string; code: number }
  start: number
  length: number
  bytecode: string
}

// prettier-ignore
const OPCODES: Record<number, string> = {
  // stop and arithmetic
  0x00: 'STOP', 0x01: 'ADD' , 0x02:  'MUL'  , 0x03: 'SUB'   , 0x04: 'DIV', 0x05: 'SDIV'      ,
  0x06: 'MOD' , 0x07: 'SMOD', 0x08: 'ADDMOD', 0x09: 'MULMOD', 0x0A: 'EXP', 0x0B: 'SIGNEXTEND',

  // comparison and bitwise logic
  0x10: 'LT', 0x11: 'GT' , 0x12: 'SLT', 0x13: 'SGT' , 0x14: 'EQ' , 0x15: 'ISZERO', 0x16: 'AND',
  0x17: 'OR', 0x18: 'XOR', 0x19: 'NOT', 0x1A: 'BYTE', 0x1B: 'SHL', 0x1c: 'SHR'   , 0x1D: 'SAR',

  // sha3
  0x20: 'SHA3',

  // environment information
  0x30: 'ADDRESS'    , 0x31: 'BALANCE'       , 0x32: 'ORIGIN'        , 0x33: 'CALLER'      ,
  0x34: 'CALLVALUE'  , 0x35: 'CALLDATALOAD'  , 0x36: 'CALLDATASIZE'  , 0x37: 'CALLDATACOPY',
  0x38: 'CODESIZE'   , 0x39: 'CODECOPY'      , 0x3A: 'GASPRICE'      , 0x3B: 'EXTCODESIZE' ,
  0x3C: 'EXTCODECOPY', 0x3D: 'RETURNDATASIZE', 0x3E: 'RETURNDATACOPY', 0x3F: 'EXTCODEHASH' ,

  // block information
  0x40: 'BLOCKHASH' , 0x41: 'COINBASE', 0x42: 'TIMESTAMP', 0x43: 'NUMBER'      ,
  0x44: 'PREVRANDAO', 0x45: 'GASLIMIT', 0x46: 'CHAINID'  , 0x47: 'SELFBALANCE' , 0x48: 'BASEFEE',

  // stack, memory, storage and flow operations
  0x50: 'POP'  , 0x51: 'MLOAD' , 0x52: 'MSTORE', 0x53: 'MSTORE8'  ,
  0x54: 'SLOAD', 0x55: 'SSTORE', 0x56: 'JUMP'  , 0x57: 'JUMPI'    ,
  0x58: 'PC'   , 0x59: 'MSIZE' , 0x5A: 'GAS'   , 0x5B: 'JUMPDEST' ,

  // push operations
  0x5F: 'PUSH0' , 0x60: 'PUSH1' , 0x61: 'PUSH2' , 0x62: 'PUSH3' , 0x63: 'PUSH4' , 0x64: 'PUSH5' ,
  0x65: 'PUSH6' , 0x66: 'PUSH7' , 0x67: 'PUSH8' , 0x68: 'PUSH9' , 0x69: 'PUSH10', 0x6A: 'PUSH11',
  0x6B: 'PUSH12', 0x6C: 'PUSH13', 0x6D: 'PUSH14', 0x6E: 'PUSH15', 0x6F: 'PUSH16', 0x70: 'PUSH17',
  0x71: 'PUSH18', 0x72: 'PUSH19', 0x73: 'PUSH20', 0x74: 'PUSH21', 0x75: 'PUSH22', 0x76: 'PUSH23',
  0x77: 'PUSH24', 0x78: 'PUSH25', 0x79: 'PUSH26', 0x7A: 'PUSH27', 0x7B: 'PUSH28', 0x7C: 'PUSH29',
  0x7D: 'PUSH30', 0x7E: 'PUSH31', 0x7F: 'PUSH32',

  // duplicate operations
  0x80: 'DUP1' , 0x81: 'DUP2' , 0x82: 'DUP3' , 0x83: 'DUP4' ,
  0x84: 'DUP5' , 0x85: 'DUP6' , 0x86: 'DUP7' , 0x87: 'DUP8' ,
  0x88: 'DUP9' , 0x89: 'DUP10', 0x8A: 'DUP11', 0x8B: 'DUP12',
  0x8C: 'DUP13', 0x8D: 'DUP14', 0x8E: 'DUP15', 0x8F: 'DUP16',

  // swap operations
   0x90: 'SWAP1' , 0x91: 'SWAP2' , 0x92: 'SWAP3' , 0x93: 'SWAP4' ,
   0x94: 'SWAP5' , 0x95: 'SWAP6' , 0x96: 'SWAP7' , 0x97: 'SWAP8' ,
   0x98: 'SWAP9' , 0x99: 'SWAP10', 0x9A: 'SWAP11', 0x9B: 'SWAP12',
   0x9C: 'SWAP13', 0x9D: 'SWAP14', 0x9E: 'SWAP15', 0x9F: 'SWAP16',

   // logging
  0xA0: 'LOG0', 0xA1: 'LOG1', 0xA2: 'LOG2', 0xA3: 'LOG3', 0xA4: 'LOG4',

  // system
  0xF0: 'CREATE' , 0xF1: 'CALL'      , 0xF2: 'CALLCODE', 0xF3: 'RETURN' , 0xF4: 'DELEGATECALL',
  0xF5: 'CREATE2', 0xFA: 'STATICCALL', 0xFD: 'REVERT'  , 0xFE: 'INVALID', 0xFF: 'SELFDESTRUCT',
}

function match(
  actualBytecode: string,
  expectedBytecode: string,
  immutables: Record<number, number>
) {
  const actualInstructions = parse(actualBytecode)
  const expectedInstructions = parse(expectedBytecode)
  const maxInstructionsCount = Math.max(actualInstructions.length, expectedInstructions.length)

  // find the differences

  const differences: number[] = []
  for (let i = 0; i < maxInstructionsCount; ++i) {
    const [actual, expected] = [actualInstructions[i], expectedInstructions[i]]
    if (!actual && !expected) {
      throw new Error('Invalid instructions data')
    } else if (actual?.bytecode !== expected?.bytecode) {
      differences.push(i)
    }
  }

  // print the differences

  if (differences.length === 0) {
    console.log('Bytecodes are fully matched')
    return
  }

  const nearLinesCount = 3
  const checkpoints = new Set([0, ...differences])

  if (actualInstructions.length > 0) {
    checkpoints.add(actualInstructions.length - 1)
  }

  if (expectedInstructions.length > 0) {
    checkpoints.add(expectedInstructions.length - 1)
  }

  for (let ind of Array.from(checkpoints)) {
    const startIndex = Math.max(0, ind - nearLinesCount)
    const lastIndex = Math.min(ind + nearLinesCount, maxInstructionsCount - 1)
    for (let i = startIndex; i <= lastIndex; ++i) {
      checkpoints.add(i)
    }
  }

  const checkpointsArray = Array.from(checkpoints).sort((a, b) => a - b)

  const hex = (index: number, padStart = 2) => {
    return `${index.toString(16).padStart(padStart, '0').toUpperCase()}`
  }
  const red = (text: any) => `\u001b[31m${text.toString()}\x1b[0m`
  const bgRed = (text: any) => `\u001b[37;41m${text.toString()}\x1b[0m`
  const green = (text: any) => `\u001b[32m${text.toString()}\x1b[0m`
  const bgGreen = (text: any) => `\u001b[37;42m${text.toString()}\x1b[0m`
  const bgYellow = (text: any) => `\u001b[37;43m${text.toString()}\x1b[0m`

  // print preamble
  console.log('---')
  console.log(`0000 00 STOP - both expected and actual bytecode instructions match`)
  console.log(`${bgRed('0x0002')} - the actual bytecode differs`)
  console.log(
    `${bgYellow('0x0001')} - the actual bytecode differs on the immutable reference position`
  )
  console.log(
    `${bgGreen('0x0003')} - the expected bytecode value when it doesn't match the actual one`
  )
  console.log(
    `${red(
      '0000 00 STOP'
    )} - the actual bytecode instruction doesn't exist, but expected is present`
  )
  console.log(
    `${green('0000 00 STOP')} -  the actual bytecode instruction exists when the expected doesn't`
  )
  console.log('---\n')

  for (let i = 0; i < checkpointsArray.length; ++i) {
    const currInd = checkpointsArray[i]
    const prevInd = checkpointsArray[i - 1]
    if (prevInd && prevInd !== currInd - 1) {
      console.log('...')
    }

    const actual = actualInstructions[currInd]
    const expected = expectedInstructions[currInd]

    if (!actual && expected) {
      const params = '0x' + expected.bytecode.slice(2)
      console.log(red(`${hex(currInd, 4)} ${hex(expected.op.code)} ${expected.op.name} ${params}`))
    } else if (actual && !expected) {
      const params = '0x' + actual.bytecode.slice(2)
      console.log(green(`${hex(currInd, 4)} ${hex(actual.op.code)} ${actual.op.name} ${params}`))
    } else if (actual && expected) {
      const opcode =
        actual.op.code === expected.op.code
          ? hex(actual.op.code)
          : bgRed(hex(actual.op.code)) + ' ' + bgGreen(hex(expected.op.code))
      const opname =
        actual.op.name === expected.op.name
          ? actual.op.name
          : bgRed(actual.op.name) + ' ' + bgGreen(expected.op.name)
      const actualParams = actual.bytecode.length === 2 ? '' : '0x' + actual.bytecode.slice(2)
      const expectedParams = expected.bytecode.length === 2 ? '' : '0x' + expected.bytecode.slice(2)

      const paramsLength = expected.bytecode.length / 2 - 1
      const isImmutable = immutables[expected.start + 1] === paramsLength
      const params =
        actualParams === expectedParams
          ? actualParams
          : isImmutable
            ? bgYellow(actualParams) + ' ' + bgGreen(expectedParams)
            : bgRed(actualParams) + ' ' + bgGreen(expectedParams)
      console.log(`${hex(currInd, 4)} ${opcode} ${opname} ${params}`)
    } else {
      throw new Error('Invalid bytecode difference data')
    }
  }
}

function parse(bytecode: string) {
  const buffer = Buffer.from(bytecode.startsWith('0x') ? bytecode.substring(2) : bytecode, 'hex')
  const instructions: Instruction[] = []
  for (let i = 0; i < buffer.length; ) {
    const opcode = buffer[i]
    // by default, the OP length is 1 byte, but for PUSH instructions, the length may vary
    const length = 1 + (opcode >= 0x5f && opcode <= 0x7f ? opcode - 0x5f : 0)
    instructions.push({
      start: i,
      length,
      op: { name: OPCODES[opcode] ?? 'INVALID', code: opcode },
      bytecode: buffer.subarray(i, i + length).toString('hex'),
    })
    i += length
  }
  return instructions
}

// ---
// HTTPS REQUESTS USING DEFAULT NODE JS FUNCTIONALITY
// ---

const requests = {
  get(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      https
        .get(url, (resp) => {
          let res = ''
          resp.on('data', (chunk) => {
            res = res + chunk
          })
          resp.on('end', () => {
            resolve(res)
          })
          resp.on('error', reject)
        })
        .on('error', reject)
    })
  },

  async getJson<T>(url: string): Promise<T> {
    return JSON.parse(await this.get(url))
  },

  post(url: string, data: any): Promise<string> {
    const dataString = JSON.stringify(data)
    const [hostname, ...path] = url.replace('https://', '').split('/')
    return new Promise<string>((resolve, reject) => {
      let data = ''
      const req = https
        .request(
          {
            hostname: hostname,
            path: '/' + path.join('/'),
            method: 'POST',
            headers: {
              accept: 'application/json',
              'content-type': 'application/json',
              'content-length': dataString.length,
            },
          },
          (res) => {
            res.on('data', (chunk) => (data += chunk))
            res.on('end', () => resolve(data))
          }
        )
        .on('error', reject)

      req.write(dataString)
      req.end()
    })
  },

  download(url: string, path: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const fileStream = createWriteStream(path)
      https
        .get(url, (resp) => {
          resp.pipe(fileStream)
          fileStream.on('finish', resolve)
          resp.once('error', (err) => {
            fileStream.close()
            reject(err)
          })
        })
        .on('error', reject)
    })
  },
}

// ---
// RUN SCRIPT
// ---

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
