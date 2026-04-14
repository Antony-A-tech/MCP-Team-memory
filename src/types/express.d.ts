declare namespace Express {
  interface Request {
    agentName?: string;
    agentRole?: string;
    readOnly?: boolean;
  }
}
