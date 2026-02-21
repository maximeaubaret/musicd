# Agent Instructions

This document contains instructions for AI agents working on this project.

## Researching the Jellyfin API

When you need to understand or implement Jellyfin API features, follow this approach:

### 1. Use the OpenAPI Specification

The official Jellyfin API spec is available at:
```
https://api.jellyfin.org/openapi/jellyfin-openapi-stable.json
```

**How to use it:**

1. Fetch the full OpenAPI JSON spec:
```bash
curl -o jellyfin-api.json https://api.jellyfin.org/openapi/jellyfin-openapi-stable.json
```

2. Search for relevant endpoints and parameters using grep:
```bash
# Find endpoints related to search
grep -B 10 -A 80 '"/Search/Hints"' jellyfin-api.json

# Find all uses of a parameter like searchTerm
grep -B 5 -A 10 '"searchTerm"' jellyfin-api.json
```

3. Review the parameter descriptions, schemas, and response types in the spec

### 2. Reference the Source Code

For deeper understanding of how endpoints work, check the Jellyfin source on GitHub:
```
https://github.com/jellyfin/jellyfin
```

**Useful locations:**
- API Controllers: `Jellyfin.Api/Controllers/`
- Search implementation: `Jellyfin.Api/Controllers/SearchController.cs`

**How to use it:**

1. Find the raw source file:
```
https://raw.githubusercontent.com/jellyfin/jellyfin/master/Jellyfin.Api/Controllers/SearchController.cs
```

2. Review the implementation to understand:
   - What fields are actually searched
   - How parameters are processed
   - Any limitations or special behavior

### Example: Discovering Search Endpoints

When implementing search functionality, we discovered:

1. **`/Users/{userId}/Items?SearchTerm=`** - Only searches item names/titles
2. **`/Search/Hints`** - Better for broad search, searches across:
   - Track/song names
   - Album names
   - Artist names
   - Album artists

This was found by:
1. Fetching the OpenAPI spec
2. Grepping for search-related endpoints
3. Reviewing the `SearchController.cs` source code
4. Comparing the parameter descriptions and implementations

### 3. Don't Rely on Assumptions

- The Jellyfin API documentation at jellyfin.org/docs focuses on server setup, not API details
- Always verify endpoint behavior using the OpenAPI spec or source code
- Don't assume what fields are searched without checking the spec
