import prompts from 'prompts'

function abort() {
  console.log('Operation was aborted by the user')
  process.exit()
}

export async function confirmOrAbort(message?: string) {
  const { isConfirmed } = await prompts(
    {
      type: 'toggle',
      name: 'isConfirmed',
      message: message ?? 'Confirm?',
      active: 'yes',
      inactive: 'no',
      initial: false,
    },
    { onCancel: abort }
  )
  if (!isConfirmed) {
    abort()
  }
  console.log()
}
