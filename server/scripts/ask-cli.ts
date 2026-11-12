/**
 * Ask one question of a fixture with the real model from server/.env (costs real money, about a cent or less):
 *   RUN_LLM_TESTS=1 npx tsx scripts/ask-cli.ts 01_card_sales_semicolon_win1252.csv "What were net sales by store?"
 * Profiles the fixture locally (no database), runs plan, sandbox, reconcile and narrate, and prints the block,
 * the SQL, the checks, and tokens, cost and latency per model call.
 */
import { describeAnswer, localAsk } from '../test/llm/localAsk.js';

const [fixture, question] = process.argv.slice(2);
if (!process.env.RUN_LLM_TESTS) {
  console.error('This calls the real model. Set RUN_LLM_TESTS=1 to run it.');
  process.exit(1);
}
if (!fixture || !question) {
  console.error('Usage: npx tsx scripts/ask-cli.ts <fixture file name> "<question>"');
  process.exit(1);
}
const answer = await localAsk(fixture, question);
console.log(describeAnswer(question, answer));
