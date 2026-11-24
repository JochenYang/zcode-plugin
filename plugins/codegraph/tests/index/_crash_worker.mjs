// Stand-in worker that never finishes starting: simulates an engine that fails
// to initialise (e.g. a broken language pack) so tests can check the pool's
// give-up path instead of hanging on jobs no worker will ever take.
throw new Error('stub worker cannot start');
