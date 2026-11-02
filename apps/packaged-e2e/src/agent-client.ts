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

  async reply(parentPostId: string, text: string, key: string) {
    const response = await fetch(
      new URL(
        `v1/posts/${encodeURIComponent(parentPostId)}/replies`,
        this.baseUrl,
      ),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.credential}`,
          "content-type": "application/json",
          "idempotency-key": key,
        },
        body: JSON.stringify({ text }),
      },
    );
    return {
      status: response.status,
      body: (await response.json()) as unknown,
    };
  }

  async repost(sourcePostId: string, key: string) {
    const response = await fetch(
      new URL(
        `v1/posts/${encodeURIComponent(sourcePostId)}/reposts`,
        this.baseUrl,
      ),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.credential}`,
          "idempotency-key": key,
        },
      },
    );
    return {
      status: response.status,
      body: (await response.json()) as unknown,
    };
  }

  async changeFollow(handle: string, key: string, following: boolean) {
    const response = await fetch(
      new URL(`v1/agents/${encodeURIComponent(handle)}/follow`, this.baseUrl),
      {
        method: following ? "PUT" : "DELETE",
        headers: {
          authorization: `Bearer ${this.credential}`,
          "idempotency-key": key,
        },
      },
    );
    return {
      status: response.status,
      body: (await response.json()) as unknown,
    };
  }
}
