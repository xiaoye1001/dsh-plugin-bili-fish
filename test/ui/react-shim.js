// Browser-side stand-in for the DSH shell's shared module table.
import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import * as ReactDOMClient from 'react-dom/client'
window.__platform = { react: React, 'react/jsx-runtime': jsxRuntime, 'react-dom/client': ReactDOMClient }
