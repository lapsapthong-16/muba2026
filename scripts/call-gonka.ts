// Standalone smoke test — run with `npm run gonka`.
// This is the CLI half of what app/call-gonka.tsx used to be; the browser half
// lives at /call-gonka and hits /api/gonka.
import { callDeepSeek, callGonka, callKimi, callMiniMax } from '../lib/gonka'

async function main() {
  console.log('==================================================')
  console.log(' Gonka Router Multi-Model Calling Test')
  console.log('==================================================\n')

  const testPrompt = 'Say hello and give one fun fact in 1 sentence!'

  try {
    console.log('👉 [1/3] Calling DeepSeek...')
    const deepseekOutput = await callDeepSeek(testPrompt)
    console.log('🤖 Model:', deepseekOutput.modelServed)
    console.log('🧾 Request ID:', deepseekOutput.requestId)
    console.log('💬 Response:', deepseekOutput.content)
    console.log('--------------------------------------------------\n')

    console.log('👉 [2/3] Calling Kimi...')
    const kimiOutput = await callKimi(testPrompt)
    console.log('🤖 Model:', kimiOutput.modelServed)
    console.log('🧾 Request ID:', kimiOutput.requestId)
    console.log('💬 Response:', kimiOutput.content)
    console.log('--------------------------------------------------\n')

    console.log('👉 [3/3] Calling MiniMax...')
    const minimaxOutput = await callMiniMax(testPrompt)
    console.log('🤖 Model:', minimaxOutput.modelServed)
    console.log('🧾 Request ID:', minimaxOutput.requestId)
    console.log('💬 Response:', minimaxOutput.content)
    console.log('--------------------------------------------------\n')

    console.log('👉 [Bonus] Calling via generic `callGonka()` method...')
    const genericOutput = await callGonka({
      model: 'DEEPSEEK', // or GONKA_MODELS.DEEPSEEK
      prompt: 'What is 2 + 2? Reply with just the number.',
    })
    console.log('💬 Generic Call Response:', genericOutput.content)
    console.log('==================================================')
  } catch (err: unknown) {
    if (err instanceof Error) {
      console.error('\n❌ Execution Error:', err.message)
    } else {
      console.error('\n❌ Unknown error occurred:', err)
    }
    process.exitCode = 1
  }
}

main()
