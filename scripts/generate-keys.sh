#!/bin/bash
# Run this once to generate your JWT signing keys
# Keep keys/private.pem SECRET - never commit it
mkdir -p keys
openssl genrsa -out keys/private.pem 4096
openssl rsa -in keys/private.pem -pubout -out keys/public.pem
echo ""
echo "✅ Keys generated in keys/"
echo "⚠️  NEVER commit keys/private.pem to git"
echo "   Add keys/*.pem to your .gitignore (already done)"
