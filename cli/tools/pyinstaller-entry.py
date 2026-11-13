import os
import sys
import certifi
from snitch.cli import main

# Frozen Python cannot rely on the build machine's certificate paths.
# Keep explicit enterprise/user trust configuration when supplied.
os.environ.setdefault("SSL_CERT_FILE", certifi.where())
sys.exit(main())
