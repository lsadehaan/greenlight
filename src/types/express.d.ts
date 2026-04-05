declare namespace Express {
  interface Request {
    apiKey?: {
      id: string;
      name: string;
    };
  }
}
