-- Firebase anonymous accounts do not have an email address. PostgreSQL unique
-- constraints allow multiple NULL values, while linked accounts remain unique.
ALTER TABLE "User" ALTER COLUMN "email" DROP NOT NULL;
