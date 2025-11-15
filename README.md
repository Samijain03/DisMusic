# DarkWave Player

A synchronized, shared music player built with Python, Flask-SocketIO, and JavaScript.
This project is designed for deployment on Render, using Postgres for the database and S3-compatible storage for file uploads.

## Tech Stack
-   **Backend:** Flask, Flask-SocketIO
-   **Frontend:** Vanilla JavaScript, HTML5 Audio, Web Audio API
-   **Database:** PostgreSQL (via SQLAlchemy)
-   **File Storage:** S3-Compatible (e.g., Backblaze B2)
-   **Deployment:** Render

## Environment Variables
To run this project, you must set the following environment variables on your hosting platform (e.g., Render):

-   `DATABASE_URL`: The connection string for your Postgres database.
-   `S3_BUCKET`: The name of your S3-compatible bucket.
-   `S3_KEY`: Your S3 access key ID.
-   `S3_SECRET`: Your S3 secret access key.
-   `S3_ENDPOINT_URL`: The full endpoint URL for your S3 service (e.g., `https://s3.us-west-004.backblazeb2.com`).