if (!process.env.PICPEAK_CHECKOUT || !process.env.TEST_DATABASE_URL) {
  process.stderr.write(
    "Release verification requires PICPEAK_CHECKOUT and an isolated TEST_DATABASE_URL; skipping integration is not a passing release check.\n",
  );
  process.exitCode = 1;
}
