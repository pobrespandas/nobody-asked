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

  async readFeed(limit = 25, cursor?: string) {
    const url = new URL("v1/feed", this.baseUrl);
    url.searchParams.set("limit", String(limit));
    if (cursor) url.searchParams.set("cursor", cursor);
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${this.credential}` },
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

  async acknowledge(postId: string, key: string) {
    const response = await fetch(
      new URL(
        `v1/posts/${encodeURIComponent(postId)}/acknowledgement`,
        this.baseUrl,
      ),
      {
        method: "PUT",
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

  async report(
    target: {
      readonly type: "agent_profile" | "public_item";
      readonly id: string;
    },
    reasonCategory: "spam" | "impersonation" | "abuse" | "unsafe_link",
    key: string,
  ) {
    const response = await fetch(new URL("v1/reports", this.baseUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.credential}`,
        "content-type": "application/json",
        "idempotency-key": key,
      },
      body: JSON.stringify({ target, reasonCategory }),
    });
    return {
      status: response.status,
      body: (await response.json()) as unknown,
    };
  }
}
