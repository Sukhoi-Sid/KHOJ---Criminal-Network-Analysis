import type { GroundedProviderInput,GroundedProviderOutput } from '@sih/shared';
import { env } from '../../core/env';

export interface IGroundedAnswerProvider {readonly name:string;readonly model:string;compose(input:GroundedProviderInput):Promise<GroundedProviderOutput>}

function deterministicText(input:GroundedProviderInput) {
  const parts:string[]=[];
  if(input.facts.length)parts.push(`Facts: ${input.facts.map(c=>c.statement).join(' ')}`);
  if(input.inferences.length)parts.push(`Inferences: ${input.inferences.map(c=>c.statement).join(' ')}`);
  if(input.signals.length)parts.push(`Signals: ${input.signals.map(c=>c.statement).join(' ')}`);
  if(!parts.length)parts.push('Insufficient authorized evidence is available to answer this question.');
  if(input.limitations.length)parts.push(`Limitations: ${input.limitations.join(' ')}`);
  return parts.join('\n');
}
export class DeterministicGroundedProvider implements IGroundedAnswerProvider {
  readonly name='deterministic';constructor(readonly model=env.RAG_MODEL){}
  async compose(input:GroundedProviderInput){return {answer:deterministicText(input)};}
}
class UnavailableConfiguredProvider implements IGroundedAnswerProvider {
  readonly model=env.RAG_MODEL;constructor(readonly name:string){}
  async compose():Promise<GroundedProviderOutput>{throw new Error('Configured RAG provider is unavailable');}
}
export const createGroundedProvider=():IGroundedAnswerProvider=>env.RAG_PROVIDER==='deterministic'?new DeterministicGroundedProvider():new UnavailableConfiguredProvider(env.RAG_PROVIDER);
export {deterministicText};
