import React from 'react';
import { CivicChatbot, CivicChatbotProps } from '../CivicChatbot';

export type CivicAiScreenProps = CivicChatbotProps;

/**
 * CivicAiScreen delegates to the full multi-turn multilingual CivicChatbot component.
 */
export const CivicAiScreen: React.FC<CivicAiScreenProps> = (props) => {
  return <CivicChatbot {...props} />;
};
