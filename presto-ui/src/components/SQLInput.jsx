/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import React from 'react';
import antlr4 from 'antlr4';
import SqlBaseLexer from '../sql-parser/SqlBaseLexer.js';
import SqlBaseParser from '../sql-parser/SqlBaseParser.js';
import SqlBaseListener from '../sql-parser/SqlBaseListener.js';
import Editor from 'react-simple-code-editor';
import { highlight, languages } from 'prismjs/components/prism-core';
import { debounce } from '../utils.js';
import 'prismjs/components/prism-sql';
// Remove primsjs theme to avoid loading error with dynamic import
// move import 'prismjs/themes/prism.css' to sql-client.jsx
// import 'prismjs/themes/prism-okaidia.css';
import { clsx } from 'clsx';
import PrestoClient from "@prestodb/presto-js-client";

// Create PrestoClient which always uses the current domain
export function createClient(catalog: string, schema: string, sessions: string): PrestoClient {
    const opt: PrestoClientConfig = {
        host: `${window.location.protocol}//${window.location.hostname}`,
        port: (window.location.port || (window.location.protocol === 'https:' ? '443' : '80')),
        user: 'prestoui',
    };
    if (catalog) {
        opt.catalog = catalog;
    }
    if (schema) {
        opt.schema = schema;
    }
    if (sessions && sessions.length > 0) {
        opt.extraHeaders = { 'X-Presto-Session': sessions };
    }
    return new PrestoClient(opt);
}

// UpperCase CharStream
class UpperCaseCharStream extends antlr4.CharStream {
    constructor(data: string) {
        super(data);
    }
    // Override
    LA(offset: number): number {
        const c = super.LA(offset);
        if (c <= 0) {
            return c;
        }
        if (c >= 97 && c <= 122) {
            return c - 32;
        }
        return c;
    }
}

// Use this to detect the `SELECT`
class SelectListener extends SqlBaseListener {
    limit = -1;
    fetchFirstNRows = -1;
    isSelect = false;

    constructor() {
        super();
    }

    enterQueryNoWith(ctx) {
        super.enterQueryNoWith(ctx);
        this.isSelect = true;
    }
    exitQueryNoWith(ctx) {
        super.exitQueryNoWith(ctx);
        this.limit = ctx.limit ? ctx.limit.text : -1;
        this.fetchFirstNRows = ctx.fetchFirstNRows ? ctx.fetchFirstNRows.text : -1;
    }
}
class SyntaxError extends antlr4.error.ErrorListener {
    error = undefined;

    syntaxError(recognizer, offendingSymbol, line, column, e, f) {
        this.error = new Error(`line: ${line}, column:${column}, msg: ${e}`);
    }
}

// Dropdown for Catalog and Schema
function SQLDropDown({ text, values = [], onSelect, selected }) {

    function selectItem(item) {
        if (item !== selected) {
            onSelect(item);
        }
    }

    return (
        <div className="btn-group">
            <button type="button" className="btn btn-secondary dropdown-toggle bg-white text-dark"
                data-bs-toggle="dropdown" aria-haspopup="true"
                aria-expanded="false">{selected ?? text}</button>
            <ul className="dropdown-menu bg-white">
                {values.map((item, idx) => (
                    <li key={idx}><a href="#" className={clsx('dropdown-item text-dark', selected === item && 'selected')} onClick={() => selectItem(item)}>{item}</a></li>
                ))}
            </ul>
        </div>
    );
}

const DEFAULT_SQL_LIMIT_VALUE = 100

function sqlCleaning(sql, errorHandler, maxLimit = DEFAULT_SQL_LIMIT_VALUE, disableLimit) {
    const lastSemicolon = /(\s*;\s*)$/m;
    const limitRE = /limit\s+(\d+|all)$/im;
    const fetchFirstRE = /fetch\s+first\s+(\d+)\s+rows\s+only$/im;
    const syntaxError = new SyntaxError();

    try {
        let cleanSql = sql.replace(lastSemicolon, '').trim();
        const parser = new SqlBaseParser(new antlr4.CommonTokenStream(new SqlBaseLexer(new UpperCaseCharStream(cleanSql))));
        const selectDetector = new SelectListener();
        parser.addErrorListener(syntaxError);
        antlr4.tree.ParseTreeWalker.DEFAULT.walk(selectDetector, parser.statement());
        //check syntax error
        if (syntaxError.error) {
            errorHandler(syntaxError.error);
            return false;
        }
        if (selectDetector.isSelect && !disableLimit) {
            if (typeof (selectDetector.limit) === 'string' || selectDetector.limit > maxLimit) {
                cleanSql= cleanSql.replace(limitRE, `limit ${maxLimit}`);
            } else if (selectDetector.fetchFirstNRows > maxLimit) {
                cleanSql = cleanSql.replace(fetchFirstRE, `fetch first ${maxLimit} rows only`);
            } else if (selectDetector.limit === -1 && selectDetector.fetchFirstNRows === -1) {
                cleanSql += ` limit ${maxLimit}`;
            }
        }
        return cleanSql
    } catch (err) {
        if (errorHandler) {
            errorHandler(err);
        }
        return false;
    }
}

// SQL Input, including sql text, catalog(optional), and schema(optional)
export function SQLInput({ handleSQL, show, enabled, initialSQL, errorHandler }) {
    const [sql, setSql] = React.useState(initialSQL);
    const [catalog, setCatalog] = React.useState(undefined);
    const [schema, setSchema] = React.useState(undefined);
    const [catalogs, setCatalogs] = React.useState([]);
    const [schemas, setSchemas] = React.useState([]);
    const [limit, setLimit] = React.useState(DEFAULT_SQL_LIMIT_VALUE);
    const [disableLimit, setDisableLimit] = React.useState(false);
    
    const checkValue = () => {
        if (sql.length > 0) {
            let cleanSql = sqlCleaning(sql, errorHandler, limit, disableLimit);
            if (cleanSql) {
                setSql(cleanSql);
                handleSQL(cleanSql, catalog, schema);
            }
        }
    };

    async function catalogSelected(catalog) {
        setCatalog(catalog);
        // also reset schema
        setSchema(undefined);
        setSchemas([]);
        // fetch schemas from the catalog
        const client = createClient();
        try {
            const fetchedSchemas = await client.getSchemas(catalog);
            setSchemas(fetchedSchemas)
        } catch (e) {
            // use this to report the issue
            console.error(e);
        }
    }
    const schemaSelected = (schema) => {
        setSchema(schema);
    }

    const changeLimit = (newLimit) => {
        // allow users to clear out default limit
        if (newLimit === '') {
            setLimit('');
            return;
        }
        const limitValue = parseInt(newLimit, 10);
        if (!isNaN(limitValue) && limitValue > 0) {
            setLimit(limitValue);
        }
    };

    const handleLimitBlur = () => {
        if (limit === '' || limit < 1) {
            setLimit(DEFAULT_SQL_LIMIT_VALUE);
        }
    };

    const debouncedChangeLimit = React.useMemo(
        () => debounce(changeLimit, 100),
        []
    );

    React.useEffect(() => {
        //fetch catalogs:
        async function getCatalogs() {
            const client = createClient();
            try {
                const fetchedCatalogs = await client.getCatalogs();
                setCatalogs(fetchedCatalogs)
            } catch (e) {
                // use this to report the issue
                console.error(e);
            }
        }
        getCatalogs();
    }, [initialSQL]);

    return (
        <div className={clsx(!show && 'visually-hidden')}>
            <div className="row">
                <div className="col-12">
                    <div className='input-group' role='group'>
                        <SQLDropDown text='Catalog' values={catalogs} onSelect={catalogSelected} selected={catalog}/>
                        &nbsp;
                        <SQLDropDown text='Schema' values={schemas} onSelect={schemaSelected} selected={schema}/>
                        &nbsp;
                        <div className="input-group-prepend ms-auto d-flex">
                            <span
                              for="limit"
                              className="input-group-text rounded-0 bg-white text-dark h-100"
                              style={{ fontSize:"12px", borderColor:"#454A58" }}
                            >
                                Limit
                            </span>
                            <input 
                                type="number" 
                                name="limit"
                                className="form-control" 
                                style={{ 
                                    width: "80px", 
                                    backgroundColor: disableLimit ? "#f6f6f6" : "white", 
                                    color: disableLimit ? "#999" : "black", 
                                    borderRadius: "0",
                                    appearance: "textfield",
                                    MozAppearance: "textfield",
                                    WebkitAppearance: "none"
                                }}
                                value={limit} 
                                min="1"
                                onChange={(e) => debouncedChangeLimit(e.target.value)}
                                onBlur={handleLimitBlur}
                                placeholder={DEFAULT_SQL_LIMIT_VALUE}
                                disabled={disableLimit}
                            />
                            &nbsp;
                            <div className="ms-3 d-flex align-items-center gap-1">
                                <input type="checkbox" value={disableLimit} onChange={(e) => setDisableLimit(e.target.checked)} />
                                <span>Disable Limit</span>
                            </div>
                        </div>
                        &nbsp;
                        <div className="btn-group" style={{ marginLeft: "auto" }}>
                            <button className={clsx('btn', 'btn-success', !enabled && 'disabled')} type="button" onClick={checkValue}>Run</button>
                        </div>
                    </div>
                </div>
            </div>
            <div className="row">
                <div className="col-12">
                    <Editor
                        value={sql}
                        onValueChange={setSql}
                        highlight={val => highlight(val, languages.sql)}
                        padding={10}
                        style={{
                            fontFamily: '"Fira code", "Fira Mono", monospace',
                            fontSize: 14,
                            borderWidth: '2px',
                            borderColor: 'black',
                            border: 'solid',
                            margin: '4px',
                        }}
                        placeholder='Type your SQL query...' />
                </div>
            </div>
        </div>
    );
}
