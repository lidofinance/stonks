import fs from 'fs/promises'
import { run, config } from 'hardhat'
import { DependencyGraph, CompilationJob, CompilerInput } from 'hardhat/types'
import {
  TASK_COMPILE_SOLIDITY_GET_DEPENDENCY_GRAPH,
  TASK_COMPILE_SOLIDITY_GET_SOURCE_NAMES,
  TASK_COMPILE_SOLIDITY_GET_COMPILATION_JOB_FOR_FILE,
  TASK_COMPILE_SOLIDITY_GET_COMPILER_INPUT,
} from 'hardhat/builtin-tasks/task-names'

const CONTRACT_PATH = process.env['CONTRACT_PATH'] ?? 'contracts/Order.sol'
const OUT_FILE = 'solc-input.json'

async function main() {
  const rootPath = config.paths.root
  const sourceNames: string[] = await run(TASK_COMPILE_SOLIDITY_GET_SOURCE_NAMES, {
    rootPath,
    sourcePaths: [CONTRACT_PATH],
  })
  const dependencyGraph: DependencyGraph = await run(TASK_COMPILE_SOLIDITY_GET_DEPENDENCY_GRAPH, {
    rootPath,
    sourceNames,
  })
  const fileToCompile = dependencyGraph
    .getResolvedFiles()
    .find((file) => file.sourceName.endsWith(CONTRACT_PATH))

  if (!fileToCompile) {
    throw new Error(`File ${CONTRACT_PATH} not found`)
  }
  const compilationJob: CompilationJob = await run(
    TASK_COMPILE_SOLIDITY_GET_COMPILATION_JOB_FOR_FILE,
    {
      dependencyGraph,
      file: fileToCompile,
    }
  )
  const compilerInput: CompilerInput = await run(TASK_COMPILE_SOLIDITY_GET_COMPILER_INPUT, {
    compilationJob,
  })

  await fs.writeFile(OUT_FILE, JSON.stringify(compilerInput, undefined, 2))
  console.log(`Solc input file for "${CONTRACT_PATH}" was save at ${OUT_FILE} file`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
