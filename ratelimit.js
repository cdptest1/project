// In-memory token-bucket rate limiting, shared by HTTP routes and socket events.
// Each key (an IP, a user id, ...) gets `max` tokens that refill evenly over `windowMs`.

class RateLimiter {
  constructor(max, windowMs) {
    this.max = max;
    this.rate = max / windowMs; // tokens per ms
    this.buckets = new Map(); // key -> { tokens, at }
    // Forget keys whose bucket has refilled, so the map doesn't grow forever
    setInterval(() => this.sweep(), windowMs).unref();
  }

  bucket(key) {
    const now = Date.now();
    const b = this.buckets.get(key) ?? { tokens: this.max, at: now };
    b.tokens = Math.min(this.max, b.tokens + (now - b.at) * this.rate);
    b.at = now;
    this.buckets.set(key, b);
    return b;
  }

  // True if `key` has a token left, without using it
  allowed(key) {
    return this.bucket(key).tokens >= 1;
  }

  // Uses a token; false if none are left
  take(key) {
    const b = this.bucket(key);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  sweep() {
    const now = Date.now();
    for (const [key, b] of this.buckets) {
      if (b.tokens + (now - b.at) * this.rate >= this.max) this.buckets.delete(key);
    }
  }
}

// Express middleware: 429 once `keyOf(req)` runs out of tokens
function limitRequests(limiter, keyOf, error = 'Too many requests. Try again later.') {
  return (req, res, next) => {
    if (limiter.take(keyOf(req))) return next();
    res.status(429).json({ error });
  };
}

module.exports = { RateLimiter, limitRequests };
