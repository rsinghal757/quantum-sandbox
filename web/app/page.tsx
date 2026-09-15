'use client';

import { useEffect, useMemo, useState } from 'react';

type Job = {
  id: string;
  kind: string;
  status: string;
  backend: string | null;
  shots: number | null;
  created_at: string;
  updated_at: string;
  error: string | null;
};

type JobDetails = Job & {
  input_payload: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  result_payload: Record<string, unknown> | null;
  circuit_qasm: string;
};

export default function HomePage() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [jobDetails, setJobDetails] = useState<JobDetails | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchJobs = async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch('/api/jobs?limit=50');
        if (!response.ok) {
          throw new Error(`Failed to load jobs (${response.status})`);
        }
        const payload = (await response.json()) as { jobs: Job[] };
        setJobs(payload.jobs);
        if (payload.jobs.length > 0 && !selectedJobId) {
          setSelectedJobId(payload.jobs[0].id);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unexpected dashboard error');
      } finally {
        setLoading(false);
      }
    };

    fetchJobs();
    const intervalId = setInterval(fetchJobs, 5000);
    return () => clearInterval(intervalId);
  }, [selectedJobId]);

  useEffect(() => {
    const fetchJob = async () => {
      if (!selectedJobId) {
        setJobDetails(null);
        return;
      }

      try {
        const response = await fetch(`/api/jobs/${selectedJobId}`);
        if (!response.ok) {
          throw new Error(`Failed to load job ${selectedJobId}`);
        }
        const payload = (await response.json()) as JobDetails;
        setJobDetails(payload);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unexpected job details error');
      }
    };

    fetchJob();
  }, [selectedJobId]);

  const statusCounts = useMemo(() => {
    return jobs.reduce<Record<string, number>>((acc, job) => {
      acc[job.status] = (acc[job.status] ?? 0) + 1;
      return acc;
    }, {});
  }, [jobs]);

  return (
    <main>
      <header>
        <h1>Quantum Sandbox Jobs Dashboard</h1>
        <p>Live view of persisted simulation jobs from the shared SQLite store.</p>
      </header>

      <section className="card-grid">
        <article className="card">
          <h2>Total Jobs</h2>
          <p className="metric">{jobs.length}</p>
        </article>
        <article className="card">
          <h2>Completed</h2>
          <p className="metric">{statusCounts.completed ?? 0}</p>
        </article>
        <article className="card">
          <h2>Running</h2>
          <p className="metric">{statusCounts.running ?? 0}</p>
        </article>
        <article className="card">
          <h2>Failed</h2>
          <p className="metric">{statusCounts.failed ?? 0}</p>
        </article>
      </section>

      {error ? <p className="error">{error}</p> : null}
      {loading ? <p>Refreshing jobs...</p> : null}

      <section className="layout">
        <div>
          <h2>Recent Jobs</h2>
          <ul className="jobs-list">
            {jobs.map((job) => (
              <li key={job.id}>
                <button
                  type="button"
                  className={job.id === selectedJobId ? 'selected' : ''}
                  onClick={() => setSelectedJobId(job.id)}
                >
                  <span>{job.kind}</span>
                  <strong>{job.status}</strong>
                  <small>{new Date(job.created_at).toLocaleString()}</small>
                </button>
              </li>
            ))}
            {jobs.length === 0 ? <li>No jobs yet. Run a circuit via MCP.</li> : null}
          </ul>
        </div>

        <div>
          <h2>Job Details</h2>
          {jobDetails ? (
            <article className="details">
              <p><strong>ID:</strong> {jobDetails.id}</p>
              <p><strong>Kind:</strong> {jobDetails.kind}</p>
              <p><strong>Status:</strong> {jobDetails.status}</p>
              <p><strong>Backend:</strong> {jobDetails.backend ?? 'n/a'}</p>
              <p><strong>Shots:</strong> {jobDetails.shots ?? 'n/a'}</p>
              {jobDetails.error ? <p className="error"><strong>Error:</strong> {jobDetails.error}</p> : null}
              <h3>Result Payload</h3>
              <pre>{JSON.stringify(jobDetails.result_payload, null, 2)}</pre>
            </article>
          ) : (
            <p>Select a job to inspect details.</p>
          )}
        </div>
      </section>
    </main>
  );
}
