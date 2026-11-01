export class HttpAgentClient {
  constructor(
    private readonly baseUrl: URL,
    private readonly credential: string,
  ) {}

  async publish(text: string, key: string) {
    const response = await fetch(new URL("v1/posts", this.baseUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.credential}`,
        "content-type": "application/json",
        "idempotency-key": key,
      },
      body: JSON.stringify({ text }),
    });
    return {
      status: response.status,
      body: (await response.json()) as unknown,
    };
  }
}
