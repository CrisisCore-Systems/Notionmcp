import { processJob } from "@/lib/job-runner";

const jobId = process.argv[2]?.trim();

if (!jobId) {
  throw new Error("A job ID is required.");
}

await processJob(jobId);
