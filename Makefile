#!/usr/bin/make
GIT_COMMIT = $(shell git rev-parse --short HEAD)

# Matches aappoint naming: dev-aappoint-reserve-with-google, aap-dev-api secrets
DEV_SERVICE_NAME   = dev-sui-booking-point-collect
DEV_SECRET_PREFIX  = dev-sui-booking
PROD_SERVICE_NAME  = sui-booking-point-collect
PROD_SECRET_PREFIX = sui-booking
GCP_PROJECT        = aappoint
GCP_REGION         = asia-southeast1

define DEPLOY_HELP
Usage: make [target]

  cloudbuild-dev     Build + deploy to dev Cloud Run (dev-sui-booking-point-collect)
  cloudbuild         Build + deploy to prod Cloud Run (sui-booking-point-collect)
  upload-secrets-dev Upload .env → Secret Manager with dev-sui-booking_* prefix
  upload-secrets     Upload .env → Secret Manager with sui-booking_* prefix

endef
export DEPLOY_HELP

.PHONY: help cloudbuild-dev cloudbuild upload-secrets-dev upload-secrets

help:
	@echo "$$DEPLOY_HELP"

cloudbuild-dev:
	gcloud builds submit . --config=cloudbuild.yaml \
	  --region $(GCP_REGION) \
	  --substitutions=SHORT_SHA=$(GIT_COMMIT),_SERVICE_NAME=$(DEV_SERVICE_NAME),_SECRET_PREFIX=$(DEV_SECRET_PREFIX) \
	  --project $(GCP_PROJECT)

cloudbuild:
	gcloud builds submit . --async --config=cloudbuild.yaml \
	  --region $(GCP_REGION) \
	  --substitutions=SHORT_SHA=$(GIT_COMMIT),_SERVICE_NAME=$(PROD_SERVICE_NAME),_SECRET_PREFIX=$(PROD_SECRET_PREFIX) \
	  --project $(GCP_PROJECT)

upload-secrets-dev:
	GCP_PROJECT_ID=$(GCP_PROJECT) SECRET_PREFIX=$(DEV_SECRET_PREFIX) ./scripts/gcp/upload-secrets-from-env.sh

upload-secrets:
	GCP_PROJECT_ID=$(GCP_PROJECT) SECRET_PREFIX=$(PROD_SECRET_PREFIX) ./scripts/gcp/upload-secrets-from-env.sh
