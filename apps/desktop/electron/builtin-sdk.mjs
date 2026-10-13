// Host-local dependency entry; distribution replaces this with a bundled alias.
export {Agent} from '@earendil-works/pi-agent-core';
export {createInitialSystemMessage, toToolDeclaration} from '@earendil-works/pi-ai';
export {streamSimple as responses} from '@earendil-works/pi-ai/api/openai-responses';
export {streamSimple as completions} from '@earendil-works/pi-ai/api/openai-completions';
export {streamSimple as anthropic} from '@earendil-works/pi-ai/api/anthropic-messages';
