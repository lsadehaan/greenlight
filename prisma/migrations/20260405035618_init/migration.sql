-- CreateEnum
CREATE TYPE "SubmissionStatus" AS ENUM ('pending', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "ReviewMode" AS ENUM ('human_only', 'ai_only', 'ai_then_human');

-- CreateEnum
CREATE TYPE "PolicyAction" AS ENUM ('block', 'flag', 'info');

-- CreateEnum
CREATE TYPE "GuardrailFailureMode" AS ENUM ('fail_open', 'fail_closed');

-- CreateEnum
CREATE TYPE "ReviewerType" AS ENUM ('human', 'ai');

-- CreateEnum
CREATE TYPE "ReviewDecision" AS ENUM ('approved', 'rejected', 'escalated');

-- CreateEnum
CREATE TYPE "PolicyEvalResult" AS ENUM ('pass', 'flag', 'block');

-- CreateEnum
CREATE TYPE "GuardrailVerdict" AS ENUM ('pass', 'fail', 'flag');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('human', 'ai', 'system', 'guardrail');

-- CreateEnum
CREATE TYPE "FeedbackOutcome" AS ENUM ('positive', 'negative', 'neutral');

-- CreateTable
CREATE TABLE "api_key" (
    "id" UUID NOT NULL,
    "key_hash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "api_key_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "submission" (
    "id" UUID NOT NULL,
    "api_key_id" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "metadata" JSONB,
    "status" "SubmissionStatus" NOT NULL DEFAULT 'pending',
    "review_mode" "ReviewMode",
    "callback_url" TEXT,
    "callback_status" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMP(3),

    CONSTRAINT "submission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policy" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "action" "PolicyAction" NOT NULL,
    "scope_channel" TEXT,
    "scope_content_type" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policy_evaluation" (
    "id" UUID NOT NULL,
    "submission_id" UUID NOT NULL,
    "policy_id" UUID NOT NULL,
    "result" "PolicyEvalResult" NOT NULL,
    "action_taken" "PolicyAction" NOT NULL,
    "details" JSONB,
    "evaluated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "policy_evaluation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guardrail" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "endpoint_url" TEXT NOT NULL,
    "timeout_ms" INTEGER NOT NULL DEFAULT 10000,
    "failure_mode" "GuardrailFailureMode" NOT NULL,
    "pipeline_order" INTEGER NOT NULL,
    "scope_channel" TEXT,
    "scope_content_type" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guardrail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guardrail_evaluation" (
    "id" UUID NOT NULL,
    "submission_id" UUID NOT NULL,
    "guardrail_id" UUID NOT NULL,
    "verdict" "GuardrailVerdict" NOT NULL,
    "confidence" DOUBLE PRECISION,
    "reasoning" TEXT,
    "categories" JSONB,
    "latency_ms" INTEGER,
    "evaluated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guardrail_evaluation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review" (
    "id" UUID NOT NULL,
    "submission_id" UUID NOT NULL,
    "reviewer_type" "ReviewerType" NOT NULL,
    "reviewer_identity" TEXT,
    "decision" "ReviewDecision" NOT NULL,
    "confidence" DOUBLE PRECISION,
    "reasoning" TEXT,
    "comment" TEXT,
    "ai_metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feedback" (
    "id" UUID NOT NULL,
    "submission_id" UUID NOT NULL,
    "outcome" "FeedbackOutcome" NOT NULL,
    "reason" TEXT,
    "data" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_event" (
    "id" UUID NOT NULL,
    "submission_id" UUID,
    "event_type" TEXT NOT NULL,
    "payload" JSONB,
    "actor" TEXT,
    "actor_type" "ActorType" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "escalation_config" (
    "id" UUID NOT NULL,
    "sla_minutes" INTEGER NOT NULL,
    "escalation_channel" TEXT NOT NULL,
    "escalation_target" TEXT NOT NULL,
    "timeout_action" TEXT NOT NULL,
    "timeout_minutes" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "escalation_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_channel" (
    "id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_channel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_config" (
    "id" UUID NOT NULL,
    "default_review_mode" "ReviewMode" NOT NULL DEFAULT 'human_only',
    "ai_confidence_threshold" DOUBLE PRECISION NOT NULL DEFAULT 0.8,
    "ai_reviewer_endpoint" TEXT,
    "ai_reviewer_timeout_ms" INTEGER NOT NULL DEFAULT 10000,
    "ai_reviewer_model" TEXT,
    "guardrail_pipeline_enabled" BOOLEAN NOT NULL DEFAULT false,
    "tier_config" JSONB,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "review_config_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "api_key_key_hash_key" ON "api_key"("key_hash");

-- CreateIndex
CREATE INDEX "submission_status_idx" ON "submission"("status");

-- CreateIndex
CREATE INDEX "submission_created_at_idx" ON "submission"("created_at");

-- CreateIndex
CREATE INDEX "submission_channel_idx" ON "submission"("channel");

-- CreateIndex
CREATE INDEX "submission_api_key_id_idx" ON "submission"("api_key_id");

-- CreateIndex
CREATE INDEX "policy_evaluation_submission_id_idx" ON "policy_evaluation"("submission_id");

-- CreateIndex
CREATE INDEX "policy_evaluation_policy_id_idx" ON "policy_evaluation"("policy_id");

-- CreateIndex
CREATE INDEX "guardrail_evaluation_submission_id_idx" ON "guardrail_evaluation"("submission_id");

-- CreateIndex
CREATE INDEX "guardrail_evaluation_guardrail_id_idx" ON "guardrail_evaluation"("guardrail_id");

-- CreateIndex
CREATE INDEX "review_submission_id_idx" ON "review"("submission_id");

-- CreateIndex
CREATE INDEX "feedback_submission_id_idx" ON "feedback"("submission_id");

-- CreateIndex
CREATE INDEX "audit_event_submission_id_idx" ON "audit_event"("submission_id");

-- CreateIndex
CREATE INDEX "audit_event_created_at_idx" ON "audit_event"("created_at");

-- AddForeignKey
ALTER TABLE "submission" ADD CONSTRAINT "submission_api_key_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "api_key"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_evaluation" ADD CONSTRAINT "policy_evaluation_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "submission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_evaluation" ADD CONSTRAINT "policy_evaluation_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "policy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guardrail_evaluation" ADD CONSTRAINT "guardrail_evaluation_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "submission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guardrail_evaluation" ADD CONSTRAINT "guardrail_evaluation_guardrail_id_fkey" FOREIGN KEY ("guardrail_id") REFERENCES "guardrail"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review" ADD CONSTRAINT "review_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "submission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "submission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "submission"("id") ON DELETE SET NULL ON UPDATE CASCADE;
