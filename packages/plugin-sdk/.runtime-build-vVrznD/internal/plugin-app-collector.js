var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// ../../node_modules/.pnpm/react@19.3.1/node_modules/react/cjs/react.production.js
var require_react_production = __commonJS({
  "../../node_modules/.pnpm/react@19.3.1/node_modules/react/cjs/react.production.js"(exports) {
    "use strict";
    var REACT_ELEMENT_TYPE = /* @__PURE__ */ Symbol.for("react.transitional.element");
    var REACT_PORTAL_TYPE = /* @__PURE__ */ Symbol.for("react.portal");
    var REACT_FRAGMENT_TYPE = /* @__PURE__ */ Symbol.for("react.fragment");
    var REACT_STRICT_MODE_TYPE = /* @__PURE__ */ Symbol.for("react.strict_mode");
    var REACT_PROFILER_TYPE = /* @__PURE__ */ Symbol.for("react.profiler");
    var REACT_CONSUMER_TYPE = /* @__PURE__ */ Symbol.for("react.consumer");
    var REACT_CONTEXT_TYPE = /* @__PURE__ */ Symbol.for("react.context");
    var REACT_FORWARD_REF_TYPE = /* @__PURE__ */ Symbol.for("react.forward_ref");
    var REACT_SUSPENSE_TYPE = /* @__PURE__ */ Symbol.for("react.suspense");
    var REACT_MEMO_TYPE = /* @__PURE__ */ Symbol.for("react.memo");
    var REACT_LAZY_TYPE = /* @__PURE__ */ Symbol.for("react.lazy");
    var REACT_ACTIVITY_TYPE = /* @__PURE__ */ Symbol.for("react.activity");
    var REACT_VIEW_TRANSITION_TYPE = /* @__PURE__ */ Symbol.for("react.view_transition");
    var MAYBE_ITERATOR_SYMBOL = Symbol.iterator;
    function getIteratorFn(maybeIterable) {
      if (null === maybeIterable || "object" !== typeof maybeIterable) return null;
      maybeIterable = MAYBE_ITERATOR_SYMBOL && maybeIterable[MAYBE_ITERATOR_SYMBOL] || maybeIterable["@@iterator"];
      return "function" === typeof maybeIterable ? maybeIterable : null;
    }
    var ReactNoopUpdateQueue = {
      isMounted: function() {
        return false;
      },
      enqueueForceUpdate: function() {
      },
      enqueueReplaceState: function() {
      },
      enqueueSetState: function() {
      }
    };
    var assign = Object.assign;
    var emptyObject = {};
    function Component(props, context, updater) {
      this.props = props;
      this.context = context;
      this.refs = emptyObject;
      this.updater = updater || ReactNoopUpdateQueue;
    }
    Component.prototype.isReactComponent = {};
    Component.prototype.setState = function(partialState, callback) {
      if ("object" !== typeof partialState && "function" !== typeof partialState && null != partialState)
        throw Error(
          "takes an object of state variables to update or a function which returns an object of state variables."
        );
      this.updater.enqueueSetState(this, partialState, callback, "setState");
    };
    Component.prototype.forceUpdate = function(callback) {
      this.updater.enqueueForceUpdate(this, callback, "forceUpdate");
    };
    function ComponentDummy() {
    }
    ComponentDummy.prototype = Component.prototype;
    function PureComponent(props, context, updater) {
      this.props = props;
      this.context = context;
      this.refs = emptyObject;
      this.updater = updater || ReactNoopUpdateQueue;
    }
    var pureComponentPrototype = PureComponent.prototype = new ComponentDummy();
    pureComponentPrototype.constructor = PureComponent;
    assign(pureComponentPrototype, Component.prototype);
    pureComponentPrototype.isPureReactComponent = true;
    var isArrayImpl = Array.isArray;
    function noop() {
    }
    var ReactSharedInternals = { H: null, A: null, T: null, S: null };
    var hasOwnProperty = Object.prototype.hasOwnProperty;
    function ReactElement(type, key, props) {
      var refProp = props.ref;
      return {
        $$typeof: REACT_ELEMENT_TYPE,
        type,
        key,
        ref: void 0 !== refProp ? refProp : null,
        props
      };
    }
    function cloneAndReplaceKey(oldElement, newKey) {
      return ReactElement(oldElement.type, newKey, oldElement.props);
    }
    function isValidElement(object) {
      return "object" === typeof object && null !== object && object.$$typeof === REACT_ELEMENT_TYPE;
    }
    function escape(key) {
      var escaperLookup = { "=": "=0", ":": "=2" };
      return "$" + key.replace(/[=:]/g, function(match) {
        return escaperLookup[match];
      });
    }
    var userProvidedKeyEscapeRegex = /\/+/g;
    function getElementKey(element, index) {
      return "object" === typeof element && null !== element && null != element.key ? escape("" + element.key) : index.toString(36);
    }
    function resolveThenable(thenable) {
      switch (thenable.status) {
        case "fulfilled":
          return thenable.value;
        case "rejected":
          throw thenable.reason;
        default:
          switch ("string" === typeof thenable.status ? thenable.then(noop, noop) : (thenable.status = "pending", thenable.then(
            function(fulfilledValue) {
              "pending" === thenable.status && (thenable.status = "fulfilled", thenable.value = fulfilledValue);
            },
            function(error) {
              "pending" === thenable.status && (thenable.status = "rejected", thenable.reason = error);
            }
          )), thenable.status) {
            case "fulfilled":
              return thenable.value;
            case "rejected":
              throw thenable.reason;
          }
      }
      throw thenable;
    }
    function mapIntoArray(children, array, escapedPrefix, nameSoFar, callback) {
      var type = typeof children;
      if ("undefined" === type || "boolean" === type) children = null;
      var invokeCallback = false;
      if (null === children) invokeCallback = true;
      else
        switch (type) {
          case "bigint":
          case "string":
          case "number":
            invokeCallback = true;
            break;
          case "object":
            switch (children.$$typeof) {
              case REACT_ELEMENT_TYPE:
              case REACT_PORTAL_TYPE:
                invokeCallback = true;
                break;
              case REACT_LAZY_TYPE:
                return invokeCallback = children._init, mapIntoArray(
                  invokeCallback(children._payload),
                  array,
                  escapedPrefix,
                  nameSoFar,
                  callback
                );
            }
        }
      if (invokeCallback)
        return callback = callback(children), invokeCallback = "" === nameSoFar ? "." + getElementKey(children, 0) : nameSoFar, isArrayImpl(callback) ? (escapedPrefix = "", null != invokeCallback && (escapedPrefix = invokeCallback.replace(userProvidedKeyEscapeRegex, "$&/") + "/"), mapIntoArray(callback, array, escapedPrefix, "", function(c) {
          return c;
        })) : null != callback && (isValidElement(callback) && (callback = cloneAndReplaceKey(
          callback,
          escapedPrefix + (null == callback.key || children && children.key === callback.key ? "" : ("" + callback.key).replace(
            userProvidedKeyEscapeRegex,
            "$&/"
          ) + "/") + invokeCallback
        )), array.push(callback)), 1;
      invokeCallback = 0;
      var nextNamePrefix = "" === nameSoFar ? "." : nameSoFar + ":";
      if (isArrayImpl(children))
        for (var i = 0; i < children.length; i++)
          nameSoFar = children[i], type = nextNamePrefix + getElementKey(nameSoFar, i), invokeCallback += mapIntoArray(
            nameSoFar,
            array,
            escapedPrefix,
            type,
            callback
          );
      else if (i = getIteratorFn(children), "function" === typeof i)
        for (children = i.call(children), i = 0; !(nameSoFar = children.next()).done; )
          nameSoFar = nameSoFar.value, type = nextNamePrefix + getElementKey(nameSoFar, i++), invokeCallback += mapIntoArray(
            nameSoFar,
            array,
            escapedPrefix,
            type,
            callback
          );
      else if ("object" === type) {
        if ("function" === typeof children.then)
          return mapIntoArray(
            resolveThenable(children),
            array,
            escapedPrefix,
            nameSoFar,
            callback
          );
        array = String(children);
        throw Error(
          "Objects are not valid as a React child (found: " + ("[object Object]" === array ? "object with keys {" + Object.keys(children).join(", ") + "}" : array) + "). If you meant to render a collection of children, use an array instead."
        );
      }
      return invokeCallback;
    }
    function mapChildren(children, func, context) {
      if (null == children) return children;
      var result = [], count = 0;
      mapIntoArray(children, result, "", "", function(child) {
        return func.call(context, child, count++);
      });
      return result;
    }
    function lazyInitializer(payload) {
      if (-1 === payload._status) {
        var ctor = payload._result, thenable = ctor();
        thenable.then(
          function(moduleObject) {
            if (0 === payload._status || -1 === payload._status)
              payload._status = 1, payload._result = moduleObject, void 0 === thenable.status && (thenable.status = "fulfilled", thenable.value = moduleObject);
          },
          function(error) {
            if (0 === payload._status || -1 === payload._status)
              payload._status = 2, payload._result = error, void 0 === thenable.status && (thenable.status = "rejected", thenable.reason = error);
          }
        );
        -1 === payload._status && (payload._status = 0, payload._result = thenable);
      }
      if (1 === payload._status) return payload._result.default;
      throw payload._result;
    }
    var reportGlobalError = "function" === typeof reportError ? reportError : function(error) {
      if ("object" === typeof window && "function" === typeof window.ErrorEvent) {
        var event = new window.ErrorEvent("error", {
          bubbles: true,
          cancelable: true,
          message: "object" === typeof error && null !== error && "string" === typeof error.message ? String(error.message) : String(error),
          error
        });
        if (!window.dispatchEvent(event)) return;
      } else if ("object" === typeof process && "function" === typeof process.emit) {
        process.emit("uncaughtException", error);
        return;
      }
      console.error(error);
    };
    function startTransition(scope) {
      var prevTransition = ReactSharedInternals.T, currentTransition = {};
      currentTransition.types = null !== prevTransition ? prevTransition.types : null;
      ReactSharedInternals.T = currentTransition;
      try {
        var returnValue = scope(), onStartTransitionFinish = ReactSharedInternals.S;
        null !== onStartTransitionFinish && onStartTransitionFinish(currentTransition, returnValue);
        "object" === typeof returnValue && null !== returnValue && "function" === typeof returnValue.then && returnValue.then(noop, reportGlobalError);
      } catch (error) {
        reportGlobalError(error);
      } finally {
        null !== prevTransition && null !== currentTransition.types && (prevTransition.types = currentTransition.types), ReactSharedInternals.T = prevTransition;
      }
    }
    function addTransitionType(type) {
      var transition = ReactSharedInternals.T;
      if (null !== transition) {
        var transitionTypes = transition.types;
        null === transitionTypes ? transition.types = [type] : -1 === transitionTypes.indexOf(type) && transitionTypes.push(type);
      } else startTransition(addTransitionType.bind(null, type));
    }
    var Children = {
      map: mapChildren,
      forEach: function(children, forEachFunc, forEachContext) {
        mapChildren(
          children,
          function() {
            forEachFunc.apply(this, arguments);
          },
          forEachContext
        );
      },
      count: function(children) {
        var n = 0;
        mapChildren(children, function() {
          n++;
        });
        return n;
      },
      toArray: function(children) {
        return mapChildren(children, function(child) {
          return child;
        }) || [];
      },
      only: function(children) {
        if (!isValidElement(children))
          throw Error(
            "React.Children.only expected to receive a single React element child."
          );
        return children;
      }
    };
    exports.Activity = REACT_ACTIVITY_TYPE;
    exports.Children = Children;
    exports.Component = Component;
    exports.Fragment = REACT_FRAGMENT_TYPE;
    exports.Profiler = REACT_PROFILER_TYPE;
    exports.PureComponent = PureComponent;
    exports.StrictMode = REACT_STRICT_MODE_TYPE;
    exports.Suspense = REACT_SUSPENSE_TYPE;
    exports.ViewTransition = REACT_VIEW_TRANSITION_TYPE;
    exports.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE = ReactSharedInternals;
    exports.__COMPILER_RUNTIME = {
      __proto__: null,
      c: function(size) {
        return ReactSharedInternals.H.useMemoCache(size);
      }
    };
    exports.addTransitionType = addTransitionType;
    exports.cache = function(fn) {
      return function() {
        return fn.apply(null, arguments);
      };
    };
    exports.cacheSignal = function() {
      return null;
    };
    exports.cloneElement = function(element, config, children) {
      if (null === element || void 0 === element)
        throw Error(
          "The argument must be a React element, but you passed " + element + "."
        );
      var props = assign({}, element.props), key = element.key;
      if (null != config)
        for (propName in void 0 !== config.key && (key = "" + config.key), config)
          !hasOwnProperty.call(config, propName) || "key" === propName || "__self" === propName || "__source" === propName || "ref" === propName && void 0 === config.ref || (props[propName] = config[propName]);
      var propName = arguments.length - 2;
      if (1 === propName) props.children = children;
      else if (1 < propName) {
        for (var childArray = Array(propName), i = 0; i < propName; i++)
          childArray[i] = arguments[i + 2];
        props.children = childArray;
      }
      return ReactElement(element.type, key, props);
    };
    exports.createContext = function(defaultValue) {
      defaultValue = {
        $$typeof: REACT_CONTEXT_TYPE,
        _currentValue: defaultValue,
        _currentValue2: defaultValue,
        _threadCount: 0,
        Provider: null,
        Consumer: null
      };
      defaultValue.Provider = defaultValue;
      defaultValue.Consumer = {
        $$typeof: REACT_CONSUMER_TYPE,
        _context: defaultValue
      };
      return defaultValue;
    };
    exports.createElement = function(type, config, children) {
      var propName, props = {}, key = null;
      if (null != config)
        for (propName in void 0 !== config.key && (key = "" + config.key), config)
          hasOwnProperty.call(config, propName) && "key" !== propName && "__self" !== propName && "__source" !== propName && (props[propName] = config[propName]);
      var childrenLength = arguments.length - 2;
      if (1 === childrenLength) props.children = children;
      else if (1 < childrenLength) {
        for (var childArray = Array(childrenLength), i = 0; i < childrenLength; i++)
          childArray[i] = arguments[i + 2];
        props.children = childArray;
      }
      if (type && type.defaultProps)
        for (propName in childrenLength = type.defaultProps, childrenLength)
          void 0 === props[propName] && (props[propName] = childrenLength[propName]);
      return ReactElement(type, key, props);
    };
    exports.createRef = function() {
      return { current: null };
    };
    exports.forwardRef = function(render) {
      return { $$typeof: REACT_FORWARD_REF_TYPE, render };
    };
    exports.isValidElement = isValidElement;
    exports.lazy = function(ctor) {
      return {
        $$typeof: REACT_LAZY_TYPE,
        _payload: { _status: -1, _result: ctor },
        _init: lazyInitializer
      };
    };
    exports.memo = function(type, compare) {
      return {
        $$typeof: REACT_MEMO_TYPE,
        type,
        compare: void 0 === compare ? null : compare
      };
    };
    exports.startTransition = startTransition;
    exports.unstable_useCacheRefresh = function() {
      return ReactSharedInternals.H.useCacheRefresh();
    };
    exports.use = function(usable) {
      return ReactSharedInternals.H.use(usable);
    };
    exports.useActionState = function(action, initialState, permalink) {
      return ReactSharedInternals.H.useActionState(action, initialState, permalink);
    };
    exports.useCallback = function(callback, deps) {
      return ReactSharedInternals.H.useCallback(callback, deps);
    };
    exports.useContext = function(Context) {
      return ReactSharedInternals.H.useContext(Context);
    };
    exports.useDebugValue = function() {
    };
    exports.useDeferredValue = function(value, initialValue) {
      return ReactSharedInternals.H.useDeferredValue(value, initialValue);
    };
    exports.useEffect = function(create, deps) {
      return ReactSharedInternals.H.useEffect(create, deps);
    };
    exports.useEffectEvent = function(callback) {
      return ReactSharedInternals.H.useEffectEvent(callback);
    };
    exports.useId = function() {
      return ReactSharedInternals.H.useId();
    };
    exports.useImperativeHandle = function(ref, create, deps) {
      return ReactSharedInternals.H.useImperativeHandle(ref, create, deps);
    };
    exports.useInsertionEffect = function(create, deps) {
      return ReactSharedInternals.H.useInsertionEffect(create, deps);
    };
    exports.useLayoutEffect = function(create, deps) {
      return ReactSharedInternals.H.useLayoutEffect(create, deps);
    };
    exports.useMemo = function(create, deps) {
      return ReactSharedInternals.H.useMemo(create, deps);
    };
    exports.useOptimistic = function(passthrough, reducer) {
      return ReactSharedInternals.H.useOptimistic(passthrough, reducer);
    };
    exports.useReducer = function(reducer, initialArg, init) {
      return ReactSharedInternals.H.useReducer(reducer, initialArg, init);
    };
    exports.useRef = function(initialValue) {
      return ReactSharedInternals.H.useRef(initialValue);
    };
    exports.useState = function(initialState) {
      return ReactSharedInternals.H.useState(initialState);
    };
    exports.useSyncExternalStore = function(subscribe, getSnapshot, getServerSnapshot) {
      return ReactSharedInternals.H.useSyncExternalStore(
        subscribe,
        getSnapshot,
        getServerSnapshot
      );
    };
    exports.useTransition = function() {
      return ReactSharedInternals.H.useTransition();
    };
    exports.version = "19.3.1";
  }
});

// ../../node_modules/.pnpm/react@19.3.1/node_modules/react/cjs/react.development.js
var require_react_development = __commonJS({
  "../../node_modules/.pnpm/react@19.3.1/node_modules/react/cjs/react.development.js"(exports, module) {
    "use strict";
    "production" !== process.env.NODE_ENV && (function() {
      function defineDeprecationWarning(methodName, info) {
        Object.defineProperty(Component.prototype, methodName, {
          get: function() {
            console.warn(
              "%s(...) is deprecated in plain JavaScript React classes. %s",
              info[0],
              info[1]
            );
          }
        });
      }
      function getIteratorFn(maybeIterable) {
        if (null === maybeIterable || "object" !== typeof maybeIterable)
          return null;
        maybeIterable = MAYBE_ITERATOR_SYMBOL && maybeIterable[MAYBE_ITERATOR_SYMBOL] || maybeIterable["@@iterator"];
        return "function" === typeof maybeIterable ? maybeIterable : null;
      }
      function warnNoop(publicInstance, callerName) {
        publicInstance = (publicInstance = publicInstance.constructor) && (publicInstance.displayName || publicInstance.name) || "ReactClass";
        var warningKey = publicInstance + "." + callerName;
        didWarnStateUpdateForUnmountedComponent[warningKey] || (console.error(
          "Can't call %s on a component that is not yet mounted. This is a no-op, but it might indicate a bug in your application. Instead, assign to `this.state` directly or define a `state = {};` class property with the desired state in the %s component.",
          callerName,
          publicInstance
        ), didWarnStateUpdateForUnmountedComponent[warningKey] = true);
      }
      function Component(props, context, updater) {
        this.props = props;
        this.context = context;
        this.refs = emptyObject;
        this.updater = updater || ReactNoopUpdateQueue;
      }
      function ComponentDummy() {
      }
      function PureComponent(props, context, updater) {
        this.props = props;
        this.context = context;
        this.refs = emptyObject;
        this.updater = updater || ReactNoopUpdateQueue;
      }
      function noop() {
      }
      function testStringCoercion(value) {
        return "" + value;
      }
      function checkKeyStringCoercion(value) {
        try {
          testStringCoercion(value);
          var JSCompiler_inline_result = false;
        } catch (e) {
          JSCompiler_inline_result = true;
        }
        if (JSCompiler_inline_result) {
          JSCompiler_inline_result = console;
          var JSCompiler_temp_const = JSCompiler_inline_result.error;
          var JSCompiler_inline_result$jscomp$0 = "function" === typeof Symbol && Symbol.toStringTag && value[Symbol.toStringTag] || value.constructor.name || "Object";
          JSCompiler_temp_const.call(
            JSCompiler_inline_result,
            "The provided key is an unsupported type %s. This value must be coerced to a string before using it here.",
            JSCompiler_inline_result$jscomp$0
          );
          return testStringCoercion(value);
        }
      }
      function getComponentNameFromType(type) {
        if (null == type) return null;
        if ("function" === typeof type)
          return type.$$typeof === REACT_CLIENT_REFERENCE ? null : type.displayName || type.name || null;
        if ("string" === typeof type) return type;
        switch (type) {
          case REACT_FRAGMENT_TYPE:
            return "Fragment";
          case REACT_PROFILER_TYPE:
            return "Profiler";
          case REACT_STRICT_MODE_TYPE:
            return "StrictMode";
          case REACT_SUSPENSE_TYPE:
            return "Suspense";
          case REACT_SUSPENSE_LIST_TYPE:
            return "SuspenseList";
          case REACT_ACTIVITY_TYPE:
            return "Activity";
          case REACT_VIEW_TRANSITION_TYPE:
            return "ViewTransition";
        }
        if ("object" === typeof type)
          switch ("number" === typeof type.tag && console.error(
            "Received an unexpected object in getComponentNameFromType(). This is likely a bug in React. Please file an issue."
          ), type.$$typeof) {
            case REACT_PORTAL_TYPE:
              return "Portal";
            case REACT_CONTEXT_TYPE:
              return type.displayName || "Context";
            case REACT_CONSUMER_TYPE:
              return (type._context.displayName || "Context") + ".Consumer";
            case REACT_FORWARD_REF_TYPE:
              var innerType = type.render;
              type = type.displayName;
              type || (type = innerType.displayName || innerType.name || "", type = "" !== type ? "ForwardRef(" + type + ")" : "ForwardRef");
              return type;
            case REACT_MEMO_TYPE:
              return innerType = type.displayName || null, null !== innerType ? innerType : getComponentNameFromType(type.type) || "Memo";
            case REACT_LAZY_TYPE:
              innerType = type._payload;
              type = type._init;
              try {
                return getComponentNameFromType(type(innerType));
              } catch (x) {
              }
          }
        return null;
      }
      function getTaskName(type) {
        if (type === REACT_FRAGMENT_TYPE) return "<>";
        if ("object" === typeof type && null !== type && type.$$typeof === REACT_LAZY_TYPE)
          return "<...>";
        try {
          var name = getComponentNameFromType(type);
          return name ? "<" + name + ">" : "<...>";
        } catch (x) {
          return "<...>";
        }
      }
      function getOwner() {
        var dispatcher = ReactSharedInternals.A;
        return null === dispatcher ? null : dispatcher.getOwner();
      }
      function UnknownOwner() {
        return Error("react-stack-top-frame");
      }
      function hasValidKey(config) {
        if (hasOwnProperty.call(config, "key")) {
          var getter = Object.getOwnPropertyDescriptor(config, "key").get;
          if (getter && getter.isReactWarning) return false;
        }
        return void 0 !== config.key;
      }
      function defineKeyPropWarningGetter(props, displayName) {
        function warnAboutAccessingKey() {
          specialPropKeyWarningShown || (specialPropKeyWarningShown = true, console.error(
            "%s: `key` is not a prop. Trying to access it will result in `undefined` being returned. If you need to access the same value within the child component, you should pass it as a different prop. (https://react.dev/link/special-props)",
            displayName
          ));
        }
        warnAboutAccessingKey.isReactWarning = true;
        Object.defineProperty(props, "key", {
          get: warnAboutAccessingKey,
          configurable: true
        });
      }
      function elementRefGetterWithDeprecationWarning() {
        var componentName = getComponentNameFromType(this.type);
        didWarnAboutElementRef[componentName] || (didWarnAboutElementRef[componentName] = true, console.error(
          "Accessing element.ref was removed in React 19. ref is now a regular prop. It will be removed from the JSX Element type in a future release."
        ));
        componentName = this.props.ref;
        return void 0 !== componentName ? componentName : null;
      }
      function ReactElement(type, key, props, owner, debugStack, debugTask) {
        var refProp = props.ref;
        type = {
          $$typeof: REACT_ELEMENT_TYPE,
          type,
          key,
          props,
          _owner: owner
        };
        null !== (void 0 !== refProp ? refProp : null) ? Object.defineProperty(type, "ref", {
          enumerable: false,
          get: elementRefGetterWithDeprecationWarning
        }) : Object.defineProperty(type, "ref", { enumerable: false, value: null });
        type._store = {};
        Object.defineProperty(type._store, "validated", {
          configurable: false,
          enumerable: false,
          writable: true,
          value: 0
        });
        Object.defineProperty(type, "_debugInfo", {
          configurable: false,
          enumerable: false,
          writable: true,
          value: null
        });
        Object.defineProperty(type, "_debugStack", {
          configurable: false,
          enumerable: false,
          writable: true,
          value: debugStack
        });
        Object.defineProperty(type, "_debugTask", {
          configurable: false,
          enumerable: false,
          writable: true,
          value: debugTask
        });
        Object.freeze && (Object.freeze(type.props), Object.freeze(type));
        return type;
      }
      function cloneAndReplaceKey(oldElement, newKey) {
        newKey = ReactElement(
          oldElement.type,
          newKey,
          oldElement.props,
          oldElement._owner,
          oldElement._debugStack,
          oldElement._debugTask
        );
        oldElement._store && (newKey._store.validated = oldElement._store.validated);
        return newKey;
      }
      function validateChildKeys(node) {
        isValidElement(node) ? node._store && (node._store.validated = 1) : "object" === typeof node && null !== node && node.$$typeof === REACT_LAZY_TYPE && ("fulfilled" === node._payload.status ? isValidElement(node._payload.value) && node._payload.value._store && (node._payload.value._store.validated = 1) : node._store && (node._store.validated = 1));
      }
      function isValidElement(object) {
        return "object" === typeof object && null !== object && object.$$typeof === REACT_ELEMENT_TYPE;
      }
      function escape(key) {
        var escaperLookup = { "=": "=0", ":": "=2" };
        return "$" + key.replace(/[=:]/g, function(match) {
          return escaperLookup[match];
        });
      }
      function getElementKey(element, index) {
        return "object" === typeof element && null !== element && null != element.key ? (checkKeyStringCoercion(element.key), escape("" + element.key)) : index.toString(36);
      }
      function resolveThenable(thenable) {
        switch (thenable.status) {
          case "fulfilled":
            return thenable.value;
          case "rejected":
            throw thenable.reason;
          default:
            switch ("string" === typeof thenable.status ? thenable.then(noop, noop) : (thenable.status = "pending", thenable.then(
              function(fulfilledValue) {
                "pending" === thenable.status && (thenable.status = "fulfilled", thenable.value = fulfilledValue);
              },
              function(error) {
                "pending" === thenable.status && (thenable.status = "rejected", thenable.reason = error);
              }
            )), thenable.status) {
              case "fulfilled":
                return thenable.value;
              case "rejected":
                throw thenable.reason;
            }
        }
        throw thenable;
      }
      function mapIntoArray(children, array, escapedPrefix, nameSoFar, callback) {
        var type = typeof children;
        if ("undefined" === type || "boolean" === type) children = null;
        var invokeCallback = false;
        if (null === children) invokeCallback = true;
        else
          switch (type) {
            case "bigint":
            case "string":
            case "number":
              invokeCallback = true;
              break;
            case "object":
              switch (children.$$typeof) {
                case REACT_ELEMENT_TYPE:
                case REACT_PORTAL_TYPE:
                  invokeCallback = true;
                  break;
                case REACT_LAZY_TYPE:
                  return invokeCallback = children._init, mapIntoArray(
                    invokeCallback(children._payload),
                    array,
                    escapedPrefix,
                    nameSoFar,
                    callback
                  );
              }
          }
        if (invokeCallback) {
          invokeCallback = children;
          callback = callback(invokeCallback);
          var childKey = "" === nameSoFar ? "." + getElementKey(invokeCallback, 0) : nameSoFar;
          isArrayImpl(callback) ? (escapedPrefix = "", null != childKey && (escapedPrefix = childKey.replace(userProvidedKeyEscapeRegex, "$&/") + "/"), mapIntoArray(callback, array, escapedPrefix, "", function(c) {
            return c;
          })) : null != callback && (isValidElement(callback) && (null != callback.key && (invokeCallback && invokeCallback.key === callback.key || checkKeyStringCoercion(callback.key)), escapedPrefix = cloneAndReplaceKey(
            callback,
            escapedPrefix + (null == callback.key || invokeCallback && invokeCallback.key === callback.key ? "" : ("" + callback.key).replace(
              userProvidedKeyEscapeRegex,
              "$&/"
            ) + "/") + childKey
          ), "" !== nameSoFar && null != invokeCallback && isValidElement(invokeCallback) && null == invokeCallback.key && invokeCallback._store && !invokeCallback._store.validated && (escapedPrefix._store.validated = 2), callback = escapedPrefix), array.push(callback));
          return 1;
        }
        invokeCallback = 0;
        childKey = "" === nameSoFar ? "." : nameSoFar + ":";
        if (isArrayImpl(children))
          for (var i = 0; i < children.length; i++)
            nameSoFar = children[i], type = childKey + getElementKey(nameSoFar, i), invokeCallback += mapIntoArray(
              nameSoFar,
              array,
              escapedPrefix,
              type,
              callback
            );
        else if (i = getIteratorFn(children), "function" === typeof i)
          for (i === children.entries && (didWarnAboutMaps || console.warn(
            "Using Maps as children is not supported. Use an array of keyed ReactElements instead."
          ), didWarnAboutMaps = true), children = i.call(children), i = 0; !(nameSoFar = children.next()).done; )
            nameSoFar = nameSoFar.value, type = childKey + getElementKey(nameSoFar, i++), invokeCallback += mapIntoArray(
              nameSoFar,
              array,
              escapedPrefix,
              type,
              callback
            );
        else if ("object" === type) {
          if ("function" === typeof children.then)
            return mapIntoArray(
              resolveThenable(children),
              array,
              escapedPrefix,
              nameSoFar,
              callback
            );
          array = String(children);
          throw Error(
            "Objects are not valid as a React child (found: " + ("[object Object]" === array ? "object with keys {" + Object.keys(children).join(", ") + "}" : array) + "). If you meant to render a collection of children, use an array instead."
          );
        }
        return invokeCallback;
      }
      function mapChildren(children, func, context) {
        if (null == children) return children;
        var result = [], count = 0;
        mapIntoArray(children, result, "", "", function(child) {
          return func.call(context, child, count++);
        });
        return result;
      }
      function lazyInitializer(payload) {
        if (-1 === payload._status) {
          var resolveDebugValue = null, rejectDebugValue = null, ioInfo = payload._ioInfo;
          null != ioInfo && (ioInfo.start = ioInfo.end = performance.now(), ioInfo.value = new Promise(function(resolve, reject) {
            resolveDebugValue = resolve;
            rejectDebugValue = reject;
          }));
          ioInfo = payload._result;
          var thenable = ioInfo();
          thenable.then(
            function(moduleObject) {
              if (0 === payload._status || -1 === payload._status) {
                payload._status = 1;
                payload._result = moduleObject;
                var _ioInfo = payload._ioInfo;
                if (null != _ioInfo) {
                  _ioInfo.end = performance.now();
                  var debugValue = null == moduleObject ? void 0 : moduleObject.default;
                  resolveDebugValue(debugValue);
                  _ioInfo.value.status = "fulfilled";
                  _ioInfo.value.value = debugValue;
                }
                void 0 === thenable.status && (thenable.status = "fulfilled", thenable.value = moduleObject);
              }
            },
            function(error) {
              if (0 === payload._status || -1 === payload._status) {
                payload._status = 2;
                payload._result = error;
                var _ioInfo2 = payload._ioInfo;
                null != _ioInfo2 && (_ioInfo2.end = performance.now(), _ioInfo2.value.then(noop, noop), rejectDebugValue(error), _ioInfo2.value.status = "rejected", _ioInfo2.value.reason = error);
                void 0 === thenable.status && (thenable.status = "rejected", thenable.reason = error);
              }
            }
          );
          ioInfo = payload._ioInfo;
          if (null != ioInfo) {
            var displayName = thenable.displayName;
            "string" === typeof displayName && (ioInfo.name = displayName);
          }
          -1 === payload._status && (payload._status = 0, payload._result = thenable);
        }
        if (1 === payload._status)
          return ioInfo = payload._result, void 0 === ioInfo && console.error(
            "lazy: Expected the result of a dynamic import() call. Instead received: %s\n\nYour code should look like: \n  const MyComponent = lazy(() => import('./MyComponent'))\n\nDid you accidentally put curly braces around the import?",
            ioInfo
          ), "default" in ioInfo || console.error(
            "lazy: Expected the result of a dynamic import() call. Instead received: %s\n\nYour code should look like: \n  const MyComponent = lazy(() => import('./MyComponent'))",
            ioInfo
          ), ioInfo.default;
        throw payload._result;
      }
      function resolveDispatcher() {
        var dispatcher = ReactSharedInternals.H;
        null === dispatcher && console.error(
          "Invalid hook call. Hooks can only be called inside of the body of a function component. This could happen for one of the following reasons:\n1. You might have mismatching versions of React and the renderer (such as React DOM)\n2. You might be breaking the Rules of Hooks\n3. You might have more than one copy of React in the same app\nSee https://react.dev/link/invalid-hook-call for tips about how to debug and fix this problem."
        );
        return dispatcher;
      }
      function releaseAsyncTransition() {
        ReactSharedInternals.asyncTransitions--;
      }
      function startTransition(scope) {
        var prevTransition = ReactSharedInternals.T, currentTransition = {};
        currentTransition.types = null !== prevTransition ? prevTransition.types : null;
        currentTransition._updatedFibers = /* @__PURE__ */ new Set();
        ReactSharedInternals.T = currentTransition;
        try {
          var returnValue = scope(), onStartTransitionFinish = ReactSharedInternals.S;
          null !== onStartTransitionFinish && onStartTransitionFinish(currentTransition, returnValue);
          "object" === typeof returnValue && null !== returnValue && "function" === typeof returnValue.then && (ReactSharedInternals.asyncTransitions++, returnValue.then(releaseAsyncTransition, releaseAsyncTransition), returnValue.then(noop, reportGlobalError));
        } catch (error) {
          reportGlobalError(error);
        } finally {
          null === prevTransition && currentTransition._updatedFibers && (scope = currentTransition._updatedFibers.size, currentTransition._updatedFibers.clear(), 10 < scope && console.warn(
            "Detected a large number of updates inside startTransition. If this is due to a subscription please re-write it to use React provided hooks. Otherwise concurrent mode guarantees are off the table."
          )), null !== prevTransition && null !== currentTransition.types && (null !== prevTransition.types && prevTransition.types !== currentTransition.types && console.error(
            "We expected inner Transitions to have transferred the outer types set and that you cannot add to the outer Transition while inside the inner.This is a bug in React."
          ), prevTransition.types = currentTransition.types), ReactSharedInternals.T = prevTransition;
        }
      }
      function addTransitionType(type) {
        var transition = ReactSharedInternals.T;
        if (null !== transition) {
          var transitionTypes = transition.types;
          null === transitionTypes ? transition.types = [type] : -1 === transitionTypes.indexOf(type) && transitionTypes.push(type);
        } else
          0 === ReactSharedInternals.asyncTransitions && console.error(
            "addTransitionType can only be called inside a `startTransition()` callback. It must be associated with a specific Transition."
          ), startTransition(addTransitionType.bind(null, type));
      }
      function enqueueTask(task) {
        if (null === enqueueTaskImpl)
          try {
            var requireString = ("require" + Math.random()).slice(0, 7);
            enqueueTaskImpl = (module && module[requireString]).call(
              module,
              "timers"
            ).setImmediate;
          } catch (_err) {
            enqueueTaskImpl = function(callback) {
              false === didWarnAboutMessageChannel && (didWarnAboutMessageChannel = true, "undefined" === typeof MessageChannel && console.error(
                "This browser does not have a MessageChannel implementation, so enqueuing tasks via await act(async () => ...) will fail. Please file an issue at https://github.com/facebook/react/issues if you encounter this warning."
              ));
              var channel = new MessageChannel();
              channel.port1.onmessage = callback;
              channel.port2.postMessage(void 0);
            };
          }
        return enqueueTaskImpl(task);
      }
      function aggregateErrors(errors) {
        return 1 < errors.length && "function" === typeof AggregateError ? new AggregateError(errors) : errors[0];
      }
      function popActScope(prevActQueue, prevActScopeDepth) {
        prevActScopeDepth !== actScopeDepth - 1 && console.error(
          "You seem to have overlapping act() calls, this is not supported. Be sure to await previous act() calls before making a new one. "
        );
        actScopeDepth = prevActScopeDepth;
      }
      function recursivelyFlushAsyncActWork(returnValue, resolve, reject) {
        var queue = ReactSharedInternals.actQueue;
        if (null !== queue)
          if (0 !== queue.length)
            try {
              flushActQueue(queue);
              enqueueTask(function() {
                return recursivelyFlushAsyncActWork(returnValue, resolve, reject);
              });
              return;
            } catch (error) {
              ReactSharedInternals.thrownErrors.push(error);
            }
          else ReactSharedInternals.actQueue = null;
        0 < ReactSharedInternals.thrownErrors.length ? (queue = aggregateErrors(ReactSharedInternals.thrownErrors), ReactSharedInternals.thrownErrors.length = 0, reject(queue)) : resolve(returnValue);
      }
      function flushActQueue(queue) {
        if (!isFlushing) {
          isFlushing = true;
          var i = 0;
          try {
            for (; i < queue.length; i++) {
              var callback = queue[i];
              do {
                ReactSharedInternals.didUsePromise = false;
                var continuation = callback(false);
                if (null !== continuation) {
                  if (ReactSharedInternals.didUsePromise) {
                    queue[i] = callback;
                    queue.splice(0, i);
                    return;
                  }
                  callback = continuation;
                } else break;
              } while (1);
            }
            queue.length = 0;
          } catch (error) {
            queue.splice(0, i + 1), ReactSharedInternals.thrownErrors.push(error);
          } finally {
            isFlushing = false;
          }
        }
      }
      "undefined" !== typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ && "function" === typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.registerInternalModuleStart && __REACT_DEVTOOLS_GLOBAL_HOOK__.registerInternalModuleStart(Error());
      var REACT_ELEMENT_TYPE = /* @__PURE__ */ Symbol.for("react.transitional.element"), REACT_PORTAL_TYPE = /* @__PURE__ */ Symbol.for("react.portal"), REACT_FRAGMENT_TYPE = /* @__PURE__ */ Symbol.for("react.fragment"), REACT_STRICT_MODE_TYPE = /* @__PURE__ */ Symbol.for("react.strict_mode"), REACT_PROFILER_TYPE = /* @__PURE__ */ Symbol.for("react.profiler"), REACT_CONSUMER_TYPE = /* @__PURE__ */ Symbol.for("react.consumer"), REACT_CONTEXT_TYPE = /* @__PURE__ */ Symbol.for("react.context"), REACT_FORWARD_REF_TYPE = /* @__PURE__ */ Symbol.for("react.forward_ref"), REACT_SUSPENSE_TYPE = /* @__PURE__ */ Symbol.for("react.suspense"), REACT_SUSPENSE_LIST_TYPE = /* @__PURE__ */ Symbol.for("react.suspense_list"), REACT_MEMO_TYPE = /* @__PURE__ */ Symbol.for("react.memo"), REACT_LAZY_TYPE = /* @__PURE__ */ Symbol.for("react.lazy"), REACT_ACTIVITY_TYPE = /* @__PURE__ */ Symbol.for("react.activity"), REACT_VIEW_TRANSITION_TYPE = /* @__PURE__ */ Symbol.for("react.view_transition"), MAYBE_ITERATOR_SYMBOL = Symbol.iterator, didWarnStateUpdateForUnmountedComponent = {}, ReactNoopUpdateQueue = {
        isMounted: function() {
          return false;
        },
        enqueueForceUpdate: function(publicInstance) {
          warnNoop(publicInstance, "forceUpdate");
        },
        enqueueReplaceState: function(publicInstance) {
          warnNoop(publicInstance, "replaceState");
        },
        enqueueSetState: function(publicInstance) {
          warnNoop(publicInstance, "setState");
        }
      }, assign = Object.assign, emptyObject = {};
      Object.freeze(emptyObject);
      Component.prototype.isReactComponent = {};
      Component.prototype.setState = function(partialState, callback) {
        if ("object" !== typeof partialState && "function" !== typeof partialState && null != partialState)
          throw Error(
            "takes an object of state variables to update or a function which returns an object of state variables."
          );
        this.updater.enqueueSetState(this, partialState, callback, "setState");
      };
      Component.prototype.forceUpdate = function(callback) {
        this.updater.enqueueForceUpdate(this, callback, "forceUpdate");
      };
      var deprecatedAPIs = {
        isMounted: [
          "isMounted",
          "Instead, make sure to clean up subscriptions and pending requests in componentWillUnmount to prevent memory leaks."
        ],
        replaceState: [
          "replaceState",
          "Refactor your code to use setState instead (see https://github.com/facebook/react/issues/3236)."
        ]
      };
      for (fnName in deprecatedAPIs)
        deprecatedAPIs.hasOwnProperty(fnName) && defineDeprecationWarning(fnName, deprecatedAPIs[fnName]);
      ComponentDummy.prototype = Component.prototype;
      deprecatedAPIs = PureComponent.prototype = new ComponentDummy();
      deprecatedAPIs.constructor = PureComponent;
      assign(deprecatedAPIs, Component.prototype);
      deprecatedAPIs.isPureReactComponent = true;
      var isArrayImpl = Array.isArray, REACT_CLIENT_REFERENCE = /* @__PURE__ */ Symbol.for("react.client.reference"), ReactSharedInternals = {
        H: null,
        A: null,
        T: null,
        S: null,
        actQueue: null,
        asyncTransitions: 0,
        isBatchingLegacy: false,
        didScheduleLegacyUpdate: false,
        didUsePromise: false,
        thrownErrors: [],
        getCurrentStack: null,
        recentlyCreatedOwnerStacks: 0
      }, hasOwnProperty = Object.prototype.hasOwnProperty, createTask = console.createTask ? console.createTask : function() {
        return null;
      };
      deprecatedAPIs = {
        react_stack_bottom_frame: function(callStackForError) {
          return callStackForError();
        }
      };
      var specialPropKeyWarningShown, didWarnAboutOldJSXRuntime;
      var didWarnAboutElementRef = {};
      var unknownOwnerDebugStack = deprecatedAPIs.react_stack_bottom_frame.bind(
        deprecatedAPIs,
        UnknownOwner
      )();
      var unknownOwnerDebugTask = createTask(getTaskName(UnknownOwner));
      var didWarnAboutMaps = false, userProvidedKeyEscapeRegex = /\/+/g, reportGlobalError = "function" === typeof reportError ? reportError : function(error) {
        if ("object" === typeof window && "function" === typeof window.ErrorEvent) {
          var event = new window.ErrorEvent("error", {
            bubbles: true,
            cancelable: true,
            message: "object" === typeof error && null !== error && "string" === typeof error.message ? String(error.message) : String(error),
            error
          });
          if (!window.dispatchEvent(event)) return;
        } else if ("object" === typeof process && "function" === typeof process.emit) {
          process.emit("uncaughtException", error);
          return;
        }
        console.error(error);
      }, didWarnAboutMessageChannel = false, enqueueTaskImpl = null, actScopeDepth = 0, didWarnNoAwaitAct = false, isFlushing = false, queueSeveralMicrotasks = "function" === typeof queueMicrotask ? function(callback) {
        queueMicrotask(function() {
          return queueMicrotask(callback);
        });
      } : enqueueTask;
      deprecatedAPIs = Object.freeze({
        __proto__: null,
        c: function(size) {
          return resolveDispatcher().useMemoCache(size);
        }
      });
      var fnName = {
        map: mapChildren,
        forEach: function(children, forEachFunc, forEachContext) {
          mapChildren(
            children,
            function() {
              forEachFunc.apply(this, arguments);
            },
            forEachContext
          );
        },
        count: function(children) {
          var n = 0;
          mapChildren(children, function() {
            n++;
          });
          return n;
        },
        toArray: function(children) {
          return mapChildren(children, function(child) {
            return child;
          }) || [];
        },
        only: function(children) {
          if (!isValidElement(children))
            throw Error(
              "React.Children.only expected to receive a single React element child."
            );
          return children;
        }
      };
      exports.Activity = REACT_ACTIVITY_TYPE;
      exports.Children = fnName;
      exports.Component = Component;
      exports.Fragment = REACT_FRAGMENT_TYPE;
      exports.Profiler = REACT_PROFILER_TYPE;
      exports.PureComponent = PureComponent;
      exports.StrictMode = REACT_STRICT_MODE_TYPE;
      exports.Suspense = REACT_SUSPENSE_TYPE;
      exports.ViewTransition = REACT_VIEW_TRANSITION_TYPE;
      exports.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE = ReactSharedInternals;
      exports.__COMPILER_RUNTIME = deprecatedAPIs;
      exports.act = function(callback) {
        var prevActQueue = ReactSharedInternals.actQueue, prevActScopeDepth = actScopeDepth;
        actScopeDepth++;
        var queue = ReactSharedInternals.actQueue = null !== prevActQueue ? prevActQueue : [], didAwaitActCall = false;
        try {
          var result = callback();
        } catch (error) {
          ReactSharedInternals.thrownErrors.push(error);
        }
        if (0 < ReactSharedInternals.thrownErrors.length)
          throw popActScope(prevActQueue, prevActScopeDepth), callback = aggregateErrors(ReactSharedInternals.thrownErrors), ReactSharedInternals.thrownErrors.length = 0, callback;
        if (null !== result && "object" === typeof result && "function" === typeof result.then) {
          var thenable = result;
          queueSeveralMicrotasks(function() {
            didAwaitActCall || didWarnNoAwaitAct || (didWarnNoAwaitAct = true, console.error(
              "You called act(async () => ...) without await. This could lead to unexpected testing behaviour, interleaving multiple act calls and mixing their scopes. You should - await act(async () => ...);"
            ));
          });
          return {
            then: function(resolve, reject) {
              didAwaitActCall = true;
              thenable.then(
                function(returnValue) {
                  popActScope(prevActQueue, prevActScopeDepth);
                  if (0 === prevActScopeDepth) {
                    try {
                      flushActQueue(queue), enqueueTask(function() {
                        return recursivelyFlushAsyncActWork(
                          returnValue,
                          resolve,
                          reject
                        );
                      });
                    } catch (error$0) {
                      ReactSharedInternals.thrownErrors.push(error$0);
                    }
                    if (0 < ReactSharedInternals.thrownErrors.length) {
                      var _thrownError = aggregateErrors(
                        ReactSharedInternals.thrownErrors
                      );
                      ReactSharedInternals.thrownErrors.length = 0;
                      reject(_thrownError);
                    }
                  } else resolve(returnValue);
                },
                function(error) {
                  popActScope(prevActQueue, prevActScopeDepth);
                  0 < ReactSharedInternals.thrownErrors.length ? (error = aggregateErrors(
                    ReactSharedInternals.thrownErrors
                  ), ReactSharedInternals.thrownErrors.length = 0, reject(error)) : reject(error);
                }
              );
            }
          };
        }
        var returnValue$jscomp$0 = result;
        popActScope(prevActQueue, prevActScopeDepth);
        0 === prevActScopeDepth && (flushActQueue(queue), 0 !== queue.length && queueSeveralMicrotasks(function() {
          didAwaitActCall || didWarnNoAwaitAct || (didWarnNoAwaitAct = true, console.error(
            "A component suspended inside an `act` scope, but the `act` call was not awaited. When testing React components that depend on asynchronous data, you must await the result:\n\nawait act(() => ...)"
          ));
        }), ReactSharedInternals.actQueue = null);
        if (0 < ReactSharedInternals.thrownErrors.length)
          throw callback = aggregateErrors(ReactSharedInternals.thrownErrors), ReactSharedInternals.thrownErrors.length = 0, callback;
        return {
          then: function(resolve, reject) {
            didAwaitActCall = true;
            0 === prevActScopeDepth ? (ReactSharedInternals.actQueue = queue, enqueueTask(function() {
              return recursivelyFlushAsyncActWork(
                returnValue$jscomp$0,
                resolve,
                reject
              );
            })) : resolve(returnValue$jscomp$0);
          }
        };
      };
      exports.addTransitionType = addTransitionType;
      exports.cache = function(fn) {
        return function() {
          return fn.apply(null, arguments);
        };
      };
      exports.cacheSignal = function() {
        return null;
      };
      exports.captureOwnerStack = function() {
        var getCurrentStack = ReactSharedInternals.getCurrentStack;
        return null === getCurrentStack ? null : getCurrentStack();
      };
      exports.cloneElement = function(element, config, children) {
        if (null === element || void 0 === element)
          throw Error(
            "The argument must be a React element, but you passed " + element + "."
          );
        var props = assign({}, element.props), key = element.key, owner = element._owner;
        if (null != config) {
          var JSCompiler_inline_result;
          a: {
            if (hasOwnProperty.call(config, "ref") && (JSCompiler_inline_result = Object.getOwnPropertyDescriptor(
              config,
              "ref"
            ).get) && JSCompiler_inline_result.isReactWarning) {
              JSCompiler_inline_result = false;
              break a;
            }
            JSCompiler_inline_result = void 0 !== config.ref;
          }
          JSCompiler_inline_result && (owner = getOwner());
          hasValidKey(config) && (checkKeyStringCoercion(config.key), key = "" + config.key);
          for (propName in config)
            !hasOwnProperty.call(config, propName) || "key" === propName || "__self" === propName || "__source" === propName || "ref" === propName && void 0 === config.ref || (props[propName] = config[propName]);
        }
        var propName = arguments.length - 2;
        if (1 === propName) props.children = children;
        else if (1 < propName) {
          JSCompiler_inline_result = Array(propName);
          for (var i = 0; i < propName; i++)
            JSCompiler_inline_result[i] = arguments[i + 2];
          props.children = JSCompiler_inline_result;
        }
        props = ReactElement(
          element.type,
          key,
          props,
          owner,
          element._debugStack,
          element._debugTask
        );
        for (key = 2; key < arguments.length; key++)
          validateChildKeys(arguments[key]);
        return props;
      };
      exports.createContext = function(defaultValue) {
        defaultValue = {
          $$typeof: REACT_CONTEXT_TYPE,
          _currentValue: defaultValue,
          _currentValue2: defaultValue,
          _threadCount: 0,
          Provider: null,
          Consumer: null
        };
        defaultValue.Provider = defaultValue;
        defaultValue.Consumer = {
          $$typeof: REACT_CONSUMER_TYPE,
          _context: defaultValue
        };
        defaultValue._currentRenderer = null;
        defaultValue._currentRenderer2 = null;
        return defaultValue;
      };
      exports.createElement = function(type, config, children) {
        for (var i = 2; i < arguments.length; i++)
          validateChildKeys(arguments[i]);
        var propName;
        i = {};
        var key = null;
        if (null != config)
          for (propName in didWarnAboutOldJSXRuntime || !("__self" in config) || "key" in config || (didWarnAboutOldJSXRuntime = true, console.warn(
            "Your app (or one of its dependencies) is using an outdated JSX transform. Update to the modern JSX transform for faster performance: https://react.dev/link/new-jsx-transform"
          )), hasValidKey(config) && (checkKeyStringCoercion(config.key), key = "" + config.key), config)
            hasOwnProperty.call(config, propName) && "key" !== propName && "__self" !== propName && "__source" !== propName && (i[propName] = config[propName]);
        var childrenLength = arguments.length - 2;
        if (1 === childrenLength) i.children = children;
        else if (1 < childrenLength) {
          for (var childArray = Array(childrenLength), _i = 0; _i < childrenLength; _i++)
            childArray[_i] = arguments[_i + 2];
          Object.freeze && Object.freeze(childArray);
          i.children = childArray;
        }
        if (type && type.defaultProps)
          for (propName in childrenLength = type.defaultProps, childrenLength)
            void 0 === i[propName] && (i[propName] = childrenLength[propName]);
        key && defineKeyPropWarningGetter(
          i,
          "function" === typeof type ? type.displayName || type.name || "Unknown" : type
        );
        (propName = 1e4 > ReactSharedInternals.recentlyCreatedOwnerStacks++) ? (childArray = Error.stackTraceLimit, Error.stackTraceLimit = 10, childrenLength = Error("react-stack-top-frame"), Error.stackTraceLimit = childArray) : childrenLength = unknownOwnerDebugStack;
        return ReactElement(
          type,
          key,
          i,
          getOwner(),
          childrenLength,
          propName ? createTask(getTaskName(type)) : unknownOwnerDebugTask
        );
      };
      exports.createRef = function() {
        var refObject = { current: null };
        Object.seal(refObject);
        return refObject;
      };
      exports.forwardRef = function(render) {
        null != render && render.$$typeof === REACT_MEMO_TYPE ? console.error(
          "forwardRef requires a render function but received a `memo` component. Instead of forwardRef(memo(...)), use memo(forwardRef(...))."
        ) : "function" !== typeof render ? console.error(
          "forwardRef requires a render function but was given %s.",
          null === render ? "null" : typeof render
        ) : 0 !== render.length && 2 !== render.length && console.error(
          "forwardRef render functions accept exactly two parameters: props and ref. %s",
          1 === render.length ? "Did you forget to use the ref parameter?" : "Any additional parameter will be undefined."
        );
        null != render && null != render.defaultProps && console.error(
          "forwardRef render functions do not support defaultProps. Did you accidentally pass a React component?"
        );
        var elementType = { $$typeof: REACT_FORWARD_REF_TYPE, render }, ownName;
        Object.defineProperty(elementType, "displayName", {
          enumerable: false,
          configurable: true,
          get: function() {
            return ownName;
          },
          set: function(name) {
            ownName = name;
            render.name || render.displayName || (Object.defineProperty(render, "name", { value: name }), render.displayName = name);
          }
        });
        return elementType;
      };
      exports.isValidElement = isValidElement;
      exports.lazy = function(ctor) {
        ctor = { _status: -1, _result: ctor };
        var lazyType = {
          $$typeof: REACT_LAZY_TYPE,
          _payload: ctor,
          _init: lazyInitializer
        }, ioInfo = {
          name: "lazy",
          start: -1,
          end: -1,
          value: null,
          owner: null,
          debugStack: Error("react-stack-top-frame"),
          debugTask: console.createTask ? console.createTask("lazy()") : null
        };
        ctor._ioInfo = ioInfo;
        lazyType._debugInfo = [{ awaited: ioInfo }];
        return lazyType;
      };
      exports.memo = function(type, compare) {
        null == type && console.error(
          "memo: The first argument must be a component. Instead received: %s",
          null === type ? "null" : typeof type
        );
        compare = {
          $$typeof: REACT_MEMO_TYPE,
          type,
          compare: void 0 === compare ? null : compare
        };
        var ownName;
        Object.defineProperty(compare, "displayName", {
          enumerable: false,
          configurable: true,
          get: function() {
            return ownName;
          },
          set: function(name) {
            ownName = name;
            type.name || type.displayName || (Object.defineProperty(type, "name", { value: name }), type.displayName = name);
          }
        });
        return compare;
      };
      exports.startTransition = startTransition;
      exports.unstable_useCacheRefresh = function() {
        return resolveDispatcher().useCacheRefresh();
      };
      exports.use = function(usable) {
        return resolveDispatcher().use(usable);
      };
      exports.useActionState = function(action, initialState, permalink) {
        return resolveDispatcher().useActionState(
          action,
          initialState,
          permalink
        );
      };
      exports.useCallback = function(callback, deps) {
        return resolveDispatcher().useCallback(callback, deps);
      };
      exports.useContext = function(Context) {
        var dispatcher = resolveDispatcher();
        Context.$$typeof === REACT_CONSUMER_TYPE && console.error(
          "Calling useContext(Context.Consumer) is not supported and will cause bugs. Did you mean to call useContext(Context) instead?"
        );
        return dispatcher.useContext(Context);
      };
      exports.useDebugValue = function(value, formatterFn) {
        return resolveDispatcher().useDebugValue(value, formatterFn);
      };
      exports.useDeferredValue = function(value, initialValue) {
        return resolveDispatcher().useDeferredValue(value, initialValue);
      };
      exports.useEffect = function(create, deps) {
        null == create && console.warn(
          "React Hook useEffect requires an effect callback. Did you forget to pass a callback to the hook?"
        );
        return resolveDispatcher().useEffect(create, deps);
      };
      exports.useEffectEvent = function(callback) {
        return resolveDispatcher().useEffectEvent(callback);
      };
      exports.useId = function() {
        return resolveDispatcher().useId();
      };
      exports.useImperativeHandle = function(ref, create, deps) {
        return resolveDispatcher().useImperativeHandle(ref, create, deps);
      };
      exports.useInsertionEffect = function(create, deps) {
        null == create && console.warn(
          "React Hook useInsertionEffect requires an effect callback. Did you forget to pass a callback to the hook?"
        );
        return resolveDispatcher().useInsertionEffect(create, deps);
      };
      exports.useLayoutEffect = function(create, deps) {
        null == create && console.warn(
          "React Hook useLayoutEffect requires an effect callback. Did you forget to pass a callback to the hook?"
        );
        return resolveDispatcher().useLayoutEffect(create, deps);
      };
      exports.useMemo = function(create, deps) {
        return resolveDispatcher().useMemo(create, deps);
      };
      exports.useOptimistic = function(passthrough, reducer) {
        return resolveDispatcher().useOptimistic(passthrough, reducer);
      };
      exports.useReducer = function(reducer, initialArg, init) {
        return resolveDispatcher().useReducer(reducer, initialArg, init);
      };
      exports.useRef = function(initialValue) {
        return resolveDispatcher().useRef(initialValue);
      };
      exports.useState = function(initialState) {
        return resolveDispatcher().useState(initialState);
      };
      exports.useSyncExternalStore = function(subscribe, getSnapshot, getServerSnapshot) {
        return resolveDispatcher().useSyncExternalStore(
          subscribe,
          getSnapshot,
          getServerSnapshot
        );
      };
      exports.useTransition = function() {
        return resolveDispatcher().useTransition();
      };
      exports.version = "19.3.1";
      "undefined" !== typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ && "function" === typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.registerInternalModuleStop && __REACT_DEVTOOLS_GLOBAL_HOOK__.registerInternalModuleStop(Error());
    })();
  }
});

// ../../node_modules/.pnpm/react@19.3.1/node_modules/react/index.js
var require_react = __commonJS({
  "../../node_modules/.pnpm/react@19.3.1/node_modules/react/index.js"(exports, module) {
    "use strict";
    if (process.env.NODE_ENV === "production") {
      module.exports = require_react_production();
    } else {
      module.exports = require_react_development();
    }
  }
});

// src/internal/sidebar-footer-runtime.ts
var sidebarFooterCommandSequence = 0;
var SidebarFooterItemRuntime = class {
  listeners = /* @__PURE__ */ new Set();
  snapshot = {
    command: null
  };
  subscribe = (listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getSnapshot = () => this.snapshot;
  acknowledgeCommand = (sequence) => {
    if (this.snapshot.command?.sequence !== sequence) return;
    this.snapshot = { ...this.snapshot, command: null };
    this.emit();
  };
  createDisclosureController() {
    return Object.freeze({
      open: () => this.request("open"),
      close: () => this.request("close"),
      toggle: () => this.request("toggle")
    });
  }
  request(kind) {
    sidebarFooterCommandSequence += 1;
    this.snapshot = {
      ...this.snapshot,
      command: { sequence: sidebarFooterCommandSequence, kind }
    };
    this.emit();
  }
  emit() {
    for (const listener of this.listeners) listener();
  }
};
function adaptSidebarFooterAction(registration) {
  return {
    source: "sidebarFooterAction",
    id: registration.id,
    label: registration.title,
    icon: registration.icon,
    kind: "action",
    onActivate: ({ openPluginDetails }) => registration.run({ openSettings: openPluginDetails }),
    runtime: new SidebarFooterItemRuntime()
  };
}
var sidebarFooterItemsByRegistrationSet = /* @__PURE__ */ new WeakMap();
function getCollectedSidebarFooterItems(registrations) {
  return sidebarFooterItemsByRegistrationSet.get(registrations) ?? null;
}

// src/internal/plugin-app-registration-collector.ts
import { z } from "zod";

// src/internal/modal-handle.ts
var import_react = __toESM(require_react(), 1);
var noHostDriver = {
  open() {
    throw new Error("experimental_modal: this host has no modal host");
  },
  close() {
  },
  subscribe: () => () => {
  },
  getOpenId: () => null
};
var driver = noHostDriver;
function installModalDriver(next) {
  driver = next;
}
function createModalHandle(pluginId, registeredIds) {
  return {
    open(modalId, options) {
      if (!registeredIds.has(modalId)) {
        throw new Error(
          `slots.experimental_modal: "${modalId}" is not a modal this plugin registered`
        );
      }
      driver.open(pluginId, modalId, options);
    },
    close() {
      driver.close();
    },
    useOpenId() {
      return (0, import_react.useSyncExternalStore)(
        driver.subscribe,
        () => driver.getOpenId(pluginId),
        () => null
      );
    }
  };
}

// src/internal/composer-customization-validation.ts
var PLUGIN_SLOT_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
var PLUGIN_MESSAGE_DIRECTIVE_ID_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
function requireSlotId(kind, value) {
  if (typeof value !== "string" || !PLUGIN_SLOT_ID_PATTERN.test(value)) {
    throw new Error(
      `${kind}: "id" must match ${String(PLUGIN_SLOT_ID_PATTERN)}, got ${JSON.stringify(value)}`
    );
  }
  return value;
}
function requireEnvironmentProviderId(kind, value) {
  if (typeof value !== "string" || !PLUGIN_SLOT_ID_PATTERN.test(value)) {
    throw new Error(
      `${kind}: "environmentProviderId" must match ${String(PLUGIN_SLOT_ID_PATTERN)}, got ${JSON.stringify(value)}`
    );
  }
  return value;
}
function requireProviderId(kind, value) {
  if (typeof value !== "string" || !PLUGIN_SLOT_ID_PATTERN.test(value)) {
    throw new Error(
      `${kind}: "providerId" must match ${String(PLUGIN_SLOT_ID_PATTERN)}, got ${JSON.stringify(value)}`
    );
  }
  return value;
}
var PLUGIN_TIMELINE_RENDERER_KIND_PATTERN = /^(tool|[a-z0-9-]+\/[a-z0-9-]+)$/u;
function requireTimelineRendererKind(kind, value) {
  if (typeof value !== "string" || !PLUGIN_TIMELINE_RENDERER_KIND_PATTERN.test(value)) {
    throw new Error(
      `${kind}: "kind" must be "tool" or "<pluginId>/<name>" (lowercase letters, digits, "-"), got ${JSON.stringify(value)}`
    );
  }
  return value;
}
function requireMessageDirectiveId(kind, value) {
  if (typeof value !== "string" || !PLUGIN_MESSAGE_DIRECTIVE_ID_PATTERN.test(value)) {
    throw new Error(
      `${kind}: "id" must match ${String(PLUGIN_MESSAGE_DIRECTIVE_ID_PATTERN)}, got ${JSON.stringify(value)}`
    );
  }
  return value;
}
function requireNonEmptyString(kind, field, value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${kind}: "${field}" must be a non-empty string`);
  }
  return value;
}
function requireOptionalString(kind, field, value) {
  if (value !== void 0 && typeof value !== "string") {
    throw new Error(`${kind}: "${field}" must be a string when set`);
  }
  return value;
}
function requireComponent(kind, value) {
  if (typeof value !== "function") {
    throw new Error(`${kind}: "component" must be a React component function`);
  }
  return value;
}
function requireFunction(kind, field, value) {
  if (typeof value !== "function") {
    throw new Error(`${kind}: "${field}" must be a function`);
  }
  return value;
}
function requireUniqueId(kind, seen, id) {
  if (seen.has(id)) {
    throw new Error(`${kind}: duplicate id "${id}"`);
  }
  seen.add(id);
}
function parseContributionArray(kind, value, onRejected, parse, seenIds = /* @__PURE__ */ new Set()) {
  if (value === void 0) return void 0;
  if (!Array.isArray(value)) {
    onRejected(`${kind}: must be an array when set`);
    return void 0;
  }
  const parsed = [];
  for (const [index, entry] of value.entries()) {
    const entryKind = `${kind}[${index}]`;
    try {
      const parsedEntry = parse(entryKind, entry);
      requireUniqueId(entryKind, seenIds, parsedEntry.id);
      parsed.push(parsedEntry);
    } catch (error) {
      onRejected(error instanceof Error ? error.message : String(error));
    }
  }
  return parsed;
}
function parseMenuItem(entryKind, value) {
  const entry = value;
  const id = requireSlotId(entryKind, entry?.id);
  const icon = requireOptionalString(entryKind, "icon", entry?.icon);
  const description = requireOptionalString(
    entryKind,
    "description",
    entry?.description
  );
  const disabled = entry?.disabled;
  if (disabled !== void 0 && typeof disabled !== "boolean" && typeof disabled !== "function") {
    throw new Error(
      `${entryKind}: "disabled" must be a boolean or function when set`
    );
  }
  return {
    id,
    label: requireNonEmptyString(entryKind, "label", entry?.label),
    ...icon !== void 0 ? { icon } : {},
    ...description !== void 0 ? { description } : {},
    ...disabled !== void 0 ? { disabled } : {},
    run: requireFunction(entryKind, "run", entry?.run)
  };
}
function parseRegions(kind, registration, onRejected, seenPopupIds) {
  const actions = parseContributionArray(`${kind}.actions`, registration.actions, onRejected, (entryKind, value) => {
    const entry = value;
    return {
      id: requireSlotId(entryKind, entry?.id),
      component: requireComponent(entryKind, entry?.component)
    };
  });
  const banners = parseContributionArray(`${kind}.banners`, registration.banners, onRejected, (entryKind, value) => {
    const entry = value;
    const id = requireSlotId(entryKind, entry?.id);
    const chrome = entry?.chrome;
    if (chrome !== void 0 && chrome !== "card" && chrome !== "bare") {
      throw new Error(
        `${entryKind}: "chrome" must be "card" or "bare" when set`
      );
    }
    return {
      id,
      ...chrome !== void 0 ? { chrome } : {},
      component: requireComponent(entryKind, entry?.component)
    };
  });
  const plusMenu = parseContributionArray(
    `${kind}.plusMenu`,
    registration.plusMenu,
    onRejected,
    parseMenuItem
  );
  const sendMenu = parseContributionArray(
    `${kind}.sendMenu`,
    registration.sendMenu,
    onRejected,
    parseMenuItem
  );
  const popups = parseContributionArray(
    `${kind}.experimental_popups`,
    registration.experimental_popups,
    onRejected,
    (entryKind, value) => {
      const entry = value;
      return {
        id: requireSlotId(entryKind, entry?.id),
        label: requireNonEmptyString(entryKind, "label", entry?.label),
        component: requireComponent(entryKind, entry?.component)
      };
    },
    seenPopupIds
  );
  let richText;
  if (registration.richText !== void 0) {
    const raw = registration.richText;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      onRejected(`${kind}.richText: must be an object when set`);
    } else {
      const effects = parseContributionArray(
        `${kind}.richText.effects`,
        raw.effects,
        onRejected,
        (entryKind, value) => {
          const entry = value;
          return {
            id: requireSlotId(entryKind, entry?.id),
            match: requireFunction(entryKind, "match", entry?.match),
            className: requireNonEmptyString(
              entryKind,
              "className",
              entry?.className
            )
          };
        }
      );
      const onDraftChange = raw.onDraftChange;
      if (onDraftChange !== void 0 && typeof onDraftChange !== "function") {
        onRejected(
          `${kind}.richText: "onDraftChange" must be a function when set`
        );
      }
      richText = {
        ...effects !== void 0 ? { effects } : {},
        ...typeof onDraftChange === "function" ? {
          onDraftChange
        } : {}
      };
    }
  }
  return {
    ...actions !== void 0 ? { actions } : {},
    ...banners !== void 0 ? { banners } : {},
    ...plusMenu !== void 0 ? { plusMenu } : {},
    ...sendMenu !== void 0 ? { sendMenu } : {},
    ...richText !== void 0 ? { richText } : {},
    ...popups !== void 0 ? { experimental_popups: popups } : {}
  };
}
function collectComposerCustomization(registration, seenIds, onRejected, seenPopupIds = /* @__PURE__ */ new Set()) {
  const kind = "composer.customize";
  try {
    const raw = registration;
    const id = requireSlotId(kind, raw?.id);
    const scopes = raw?.scopes;
    if (scopes !== void 0) {
      if (!Array.isArray(scopes)) {
        throw new Error(`${kind}: "scopes" must be an array when set`);
      }
      for (const scope of scopes) {
        if (scope !== "thread" && scope !== "queued-message" && scope !== "side-chat" && scope !== "new-thread") {
          throw new Error(
            `${kind}: invalid scope kind ${JSON.stringify(scope)}`
          );
        }
      }
    }
    requireUniqueId(kind, seenIds, id);
    return {
      id,
      ...scopes !== void 0 ? {
        scopes: scopes.filter(
          (scope) => scope !== "side-chat"
        )
      } : {},
      ...parseRegions(`${kind}(${id})`, raw ?? {}, onRejected, seenPopupIds)
    };
  } catch (error) {
    onRejected(error instanceof Error ? error.message : String(error));
    return null;
  }
}

// src/internal/plugin-app-registration-collector.ts
var CODE_FENCE_LANGUAGE_PATTERN = /^[a-z0-9][a-z0-9+#._-]*$/;
var SIDEBAR_FOOTER_ACTION_KEYS = /* @__PURE__ */ new Set([
  "id",
  "label",
  "icon",
  "kind",
  "onActivate"
]);
var SIDEBAR_FOOTER_DISCLOSURE_KEYS = /* @__PURE__ */ new Set([
  "id",
  "label",
  "icon",
  "kind",
  "component"
]);
var SidebarFooterCollector = class {
  constructor(collected, allCollected, seenIds) {
    this.collected = collected;
    this.allCollected = allCollected;
    this.seenIds = seenIds;
  }
  collected;
  allCollected;
  seenIds;
  register(registration) {
    const kind = "experimental_sidebarFooter.register";
    const id = requireSlotId(kind, registration?.id);
    requireUniqueId(kind, this.seenIds, id);
    const label = requireNonEmptyString(kind, "label", registration.label);
    const icon = requireNonEmptyString(kind, "icon", registration.icon);
    const runtime = new SidebarFooterItemRuntime();
    if (registration.kind === "action") {
      this.rejectUnknownKeys(kind, registration, SIDEBAR_FOOTER_ACTION_KEYS);
      if (typeof registration.onActivate !== "function") {
        throw new Error(`${kind}: "onActivate" must be a function`);
      }
      const item = {
        id,
        label,
        icon,
        kind: "action",
        onActivate: registration.onActivate,
        source: "experimental_sidebarFooter",
        runtime
      };
      this.collected.push(item);
      this.allCollected.push(item);
      return;
    }
    if (registration.kind === "disclosure") {
      this.rejectUnknownKeys(
        kind,
        registration,
        SIDEBAR_FOOTER_DISCLOSURE_KEYS
      );
      const item = {
        id,
        label,
        icon,
        kind: "disclosure",
        component: requireComponent(kind, registration.component),
        source: "experimental_sidebarFooter",
        runtime
      };
      this.collected.push(item);
      this.allCollected.push(item);
      return runtime.createDisclosureController();
    }
    throw new Error(`${kind}: "kind" must be "action" or "disclosure"`);
  }
  rejectUnknownKeys(kind, registration, allowed) {
    for (const key of Object.keys(registration)) {
      if (!allowed.has(key)) throw new Error(`${kind}: unknown field "${key}"`);
    }
  }
};
var NAV_PANEL_REGISTRATION_KEYS = {
  id: true,
  title: true,
  icon: true,
  path: true,
  component: true,
  fixedTabs: true,
  experimental_useBadge: true,
  experimental_usePageTitle: true,
  experimental_sidebar: true,
  headerContent: true
};
var RENAMED_NAV_PANEL_KEYS = /* @__PURE__ */ new Map([
  ["experimental_fixedTabs", 'was renamed to "fixedTabs" in SDK 0.4.16']
]);
var RETIRED_NAV_PANEL_KEYS = /* @__PURE__ */ new Map([
  [
    "experimental_sidebarAccessory",
    'is ignored: it was replaced by "experimental_useBadge", a hook returning a badge value, in SDK 0.6.53'
  ]
]);
function checkStaleNavPanelKeys(kind, registration, onWarning) {
  for (const key of Object.keys(registration)) {
    if (Object.hasOwn(NAV_PANEL_REGISTRATION_KEYS, key)) continue;
    const renamed = RENAMED_NAV_PANEL_KEYS.get(key);
    if (renamed !== void 0) {
      throw new Error(`${kind}: "${key}" ${renamed}`);
    }
    const retired = RETIRED_NAV_PANEL_KEYS.get(key);
    if (retired !== void 0) {
      onWarning(`${kind}: "${key}" ${retired}`);
      continue;
    }
    if (key.startsWith("experimental_")) {
      throw new Error(`${kind}: unknown field "${key}"`);
    }
  }
}
function createCommandShortcutSchema() {
  return z.object({
    key: z.string().min(1).max(32).refine(
      (key) => ![
        "Alt",
        "Control",
        "Meta",
        "OS",
        "Shift",
        "Dead",
        "Unidentified"
      ].includes(key)
    ),
    mod: z.boolean().default(false),
    meta: z.boolean().default(false),
    control: z.boolean().default(false),
    alt: z.boolean().default(false),
    shift: z.boolean().default(false)
  }).strict().refine(
    (shortcut) => shortcut.mod || shortcut.meta || shortcut.control || shortcut.alt || /^F(?:[1-9]|1[0-9]|2[0-4])$/u.test(shortcut.key),
    "Use Command, Control, or Alt with a key, or a function key"
  );
}
function requireOptionalOrder(kind, order) {
  if (order === void 0) return {};
  if (!Number.isFinite(order)) {
    throw new Error(`${kind}: "order" must be a finite number`);
  }
  return { order };
}
function collectTitledComponent(kind, seen, registration) {
  const id = requireSlotId(kind, registration?.id);
  requireUniqueId(kind, seen, id);
  const description = requireOptionalString(
    kind,
    "description",
    registration.description
  );
  return {
    id,
    title: requireNonEmptyString(kind, "title", registration.title),
    ...description !== void 0 ? { description } : {},
    component: requireComponent(kind, registration.component)
  };
}
function collectPanelAction(kind, seen, registration) {
  const id = requireSlotId(kind, registration?.id);
  requireUniqueId(kind, seen, id);
  if (registration.run !== void 0 && typeof registration.run !== "function") {
    throw new Error(`${kind}: "run" must be a function when set`);
  }
  if (registration.layout !== void 0 && registration.layout !== "padded" && registration.layout !== "flush") {
    throw new Error(`${kind}: "layout" must be "padded" or "flush"`);
  }
  return {
    id,
    title: requireNonEmptyString(kind, "title", registration.title),
    ...registration.icon !== void 0 ? { icon: requireNonEmptyString(kind, "icon", registration.icon) } : {},
    component: requireComponent(kind, registration.component),
    ...registration.layout !== void 0 ? { layout: registration.layout } : {},
    ...registration.run !== void 0 ? { run: registration.run } : {}
  };
}
function collectPluginAppRegistrations(definition, onWarning = (message) => console.warn(message), pluginId) {
  const commandShortcutSchema = createCommandShortcutSchema();
  const sidebarFooterItems = [];
  const collected = {
    homepageSections: [],
    settingsSections: [],
    appOverlays: [],
    modals: [],
    setupGuideSections: [],
    navPanels: [],
    tabs: [],
    get threadPanelActions() {
      return this.tabs.filter(
        (tab) => tab.context.kind === "thread" && tab.availability === "action"
      );
    },
    newThreadPanelActions: [],
    composerCustomizations: [],
    pendingInteractions: [],
    sidebarFooterActions: [],
    experimentalSidebarFooterItems: [],
    threadLists: [],
    experimentalSidebarNavigations: [],
    threadHeaderActions: [],
    threadContextSegments: [],
    threadInfoRows: [],
    threadRowMetadata: [],
    threadInfoSections: [],
    threadContextCardRows: [],
    threadContextCardSections: [],
    threadActions: [],
    browserToolbarActions: [],
    fileOpeners: [],
    sourceCodeRenderers: [],
    diffRenderers: [],
    composers: [],
    messageDirectives: [],
    codeFenceRenderers: [],
    messageActions: [],
    messageMetadata: [],
    commandPaletteActions: [],
    providerIcons: [],
    icons: [],
    timelineRenderers: [],
    environmentProviderInputs: [],
    machineProviderInputs: [],
    contentScripts: [],
    threadDisplayPolicies: []
  };
  sidebarFooterItemsByRegistrationSet.set(collected, sidebarFooterItems);
  let modalHandle = null;
  const seenIds = {
    homepageSection: /* @__PURE__ */ new Set(),
    settingsSection: /* @__PURE__ */ new Set(),
    appOverlay: /* @__PURE__ */ new Set(),
    modal: /* @__PURE__ */ new Set(),
    setupGuideSection: /* @__PURE__ */ new Set(),
    navPanel: /* @__PURE__ */ new Set(),
    tab: /* @__PURE__ */ new Set(),
    newThreadPanelAction: /* @__PURE__ */ new Set(),
    composerCustomization: /* @__PURE__ */ new Set(),
    composerPopup: /* @__PURE__ */ new Set(),
    pendingInteraction: /* @__PURE__ */ new Set(),
    sidebarFooterItem: /* @__PURE__ */ new Set(),
    threadList: /* @__PURE__ */ new Set(),
    sidebarNavigation: /* @__PURE__ */ new Set(),
    sidebarHeader: /* @__PURE__ */ new Set(),
    threadHeaderAction: /* @__PURE__ */ new Set(),
    threadContextSegment: /* @__PURE__ */ new Set(),
    threadInfoRow: /* @__PURE__ */ new Set(),
    threadRowMetadata: /* @__PURE__ */ new Set(),
    threadInfoSection: /* @__PURE__ */ new Set(),
    threadContextCardRow: /* @__PURE__ */ new Set(),
    threadContextCardSection: /* @__PURE__ */ new Set(),
    threadAction: /* @__PURE__ */ new Set(),
    browserToolbarAction: /* @__PURE__ */ new Set(),
    fileOpener: /* @__PURE__ */ new Set(),
    sourceCodeRenderer: /* @__PURE__ */ new Set(),
    diffRenderer: /* @__PURE__ */ new Set(),
    composer: /* @__PURE__ */ new Set(),
    messageDirective: /* @__PURE__ */ new Set(),
    codeFenceRenderer: /* @__PURE__ */ new Set(),
    codeFenceLanguage: /* @__PURE__ */ new Set(),
    messageAction: /* @__PURE__ */ new Set(),
    messageMetadata: /* @__PURE__ */ new Set(),
    command: /* @__PURE__ */ new Set(),
    providerIcon: /* @__PURE__ */ new Set(),
    timelineRenderer: /* @__PURE__ */ new Set(),
    environmentProviderInputs: /* @__PURE__ */ new Set(),
    machineProviderInputs: /* @__PURE__ */ new Set(),
    contentScript: /* @__PURE__ */ new Set()
  };
  function collectTab(value, legacy = false) {
    const registration = value;
    const kind = "slots.experimental_tab";
    const id = requireSlotId(kind, registration?.id);
    const context = registration.context;
    if (context?.kind !== "thread" && context?.kind !== "nav-panel") {
      throw new Error(`${kind}: context must be thread or nav-panel`);
    }
    if (context.kind === "nav-panel") requireSlotId(kind, context.panelId);
    const availability = registration.availability;
    if (availability !== "fixed" && availability !== "action") {
      throw new Error(`${kind}: availability must be fixed or action`);
    }
    requireUniqueId(
      kind,
      seenIds.tab,
      `${context.kind}/${context.kind === "nav-panel" ? context.panelId : ""}/${id}`
    );
    if (registration.useVisible !== void 0 && typeof registration.useVisible !== "function") {
      throw new Error(`${kind}: useVisible must be a function`);
    }
    if (availability === "fixed" && (registration.run !== void 0 || registration.params !== void 0)) {
      throw new Error(`${kind}: run and params require action availability`);
    }
    const target = registration.experimental_target;
    if (target !== void 0 && (availability !== "fixed" || typeof target?.validate !== "function")) {
      throw new Error(
        `${kind}: experimental_target requires a fixed tab and a validate function`
      );
    }
    const validated = {
      ...registration,
      ...collectPanelAction(kind, /* @__PURE__ */ new Set(), {
        ...registration,
        icon: legacy && registration.icon === "" ? void 0 : registration.icon
      }),
      icon: legacy && registration.icon === "" ? "" : requireNonEmptyString(kind, "icon", registration.icon),
      ...registration.tooltip === void 0 ? {} : {
        tooltip: requireNonEmptyString(
          kind,
          "tooltip",
          registration.tooltip
        )
      },
      ...availability === "action" && registration.params !== void 0 ? { params: z.json().parse(registration.params) } : {}
    };
    collected.tabs.push(validated);
  }
  function collectCommand(kind, registration) {
    const id = requireSlotId(kind, registration?.id);
    requireUniqueId(kind, seenIds.command, id);
    if (typeof registration.run !== "function") {
      throw new Error(`${kind}: "run" must be a function`);
    }
    return {
      id,
      defaultShortcut: registration.defaultShortcut === void 0 ? null : commandShortcutSchema.parse(registration.defaultShortcut),
      title: requireNonEmptyString(kind, "title", registration.title)
    };
  }
  function registerCommand(registration) {
    const kind = "commands.register";
    const command = collectCommand(kind, registration);
    if (registration.isAvailable !== void 0 && typeof registration.isAvailable !== "function") {
      throw new Error(`${kind}: "isAvailable" must be a function`);
    }
    collected.commandPaletteActions.push({
      target: "app",
      ...command,
      ...registration.isAvailable !== void 0 ? { isAvailable: registration.isAvailable } : {},
      run: registration.run
    });
  }
  function registerComposerCommand(registration) {
    collected.commandPaletteActions.push({
      target: "composer",
      ...collectCommand("composer.experimental_registerCommand", registration),
      run: registration.run
    });
  }
  const legacySidebarHeaders = [];
  const legacySlotAliases = {
    threadPanelAction(registration) {
      try {
        const action = collectPanelAction(
          "slots.threadPanelAction",
          /* @__PURE__ */ new Set(),
          registration
        );
        collectTab(
          {
            ...action,
            icon: action.icon ?? "",
            context: { kind: "thread" },
            availability: "action"
          },
          true
        );
      } catch (error) {
        onWarning(`Legacy threadPanelAction ignored: ${String(error)}`);
      }
    },
    experimental_threadHeaderAction(registration) {
      const kind = "slots.experimental_threadHeaderAction";
      const id = requireSlotId(kind, registration?.id);
      requireUniqueId(kind, seenIds.threadHeaderAction, id);
      collected.threadHeaderActions.push({
        id,
        title: requireNonEmptyString(kind, "title", registration.title),
        component: requireComponent(kind, registration.component)
      });
    },
    experimental_sidebarHeader(registration) {
      legacySidebarHeaders.push(
        collectTitledComponent(
          "slots.experimental_sidebarHeader",
          seenIds.sidebarHeader,
          registration
        ).component
      );
    }
  };
  definition.setup({
    commands: { register: registerCommand },
    slots: {
      ...legacySlotAliases,
      homepageSection(registration) {
        const kind = "slots.homepageSection";
        const id = requireSlotId(kind, registration?.id);
        requireUniqueId(kind, seenIds.homepageSection, id);
        collected.homepageSections.push({
          id,
          title: requireNonEmptyString(kind, "title", registration.title),
          component: requireComponent(kind, registration.component)
        });
      },
      settingsSection(registration) {
        const kind = "slots.settingsSection";
        const id = requireSlotId(kind, registration?.id);
        requireUniqueId(kind, seenIds.settingsSection, id);
        const title = requireOptionalString(kind, "title", registration.title);
        const description = requireOptionalString(
          kind,
          "description",
          registration.description
        );
        const page = registration.experimental_page;
        if (page !== void 0 && page !== "mobile") {
          throw new Error(`${kind}: experimental_page must be "mobile"`);
        }
        collected.settingsSections.push({
          ...page !== void 0 ? { experimental_page: page } : {},
          id,
          ...title !== void 0 ? { title } : {},
          ...description !== void 0 ? { description } : {},
          component: requireComponent(kind, registration.component)
        });
      },
      experimental_appOverlay(registration) {
        const kind = "slots.experimental_appOverlay";
        const id = requireSlotId(kind, registration?.id);
        requireUniqueId(kind, seenIds.appOverlay, id);
        collected.appOverlays.push({
          id,
          component: requireComponent(kind, registration.component)
        });
      },
      experimental_modal(registration) {
        const kind = "slots.experimental_modal";
        const id = requireSlotId(kind, registration?.id);
        requireUniqueId(kind, seenIds.modal, id);
        collected.modals.push({
          id,
          component: requireComponent(kind, registration.component)
        });
        modalHandle ??= createModalHandle(pluginId ?? null, seenIds.modal);
        return modalHandle;
      },
      internal_DO_NOT_USE_setupGuideSection(registration) {
        const kind = "slots.internal_DO_NOT_USE_setupGuideSection";
        const id = requireSlotId(kind, registration?.id);
        requireUniqueId(kind, seenIds.setupGuideSection, id);
        collected.setupGuideSections.push({
          id,
          component: requireComponent(kind, registration.component)
        });
      },
      navPanel(registration) {
        const kind = "slots.navPanel";
        const id = requireSlotId(kind, registration?.id);
        requireUniqueId(kind, seenIds.navPanel, id);
        checkStaleNavPanelKeys(kind, registration, onWarning);
        const panelId = id;
        const path = requireNonEmptyString(kind, "path", registration.path);
        if (!PLUGIN_SLOT_ID_PATTERN.test(path)) {
          throw new Error(
            `${kind}: "path" must match ${String(PLUGIN_SLOT_ID_PATTERN)} (it becomes a URL segment), got ${JSON.stringify(path)}`
          );
        }
        if (registration.headerContent !== void 0 && typeof registration.headerContent !== "function") {
          throw new Error(
            `${kind}: "headerContent" must be a React component function when set`
          );
        }
        if (registration.experimental_useBadge !== void 0 && typeof registration.experimental_useBadge !== "function") {
          throw new Error(
            `${kind}: "experimental_useBadge" must be a React hook function when set`
          );
        }
        if (registration.experimental_sidebar !== void 0 && typeof registration.experimental_sidebar !== "function") {
          throw new Error(
            `${kind}: "experimental_sidebar" must be a React component function when set`
          );
        }
        if (registration.experimental_usePageTitle !== void 0 && typeof registration.experimental_usePageTitle !== "function") {
          throw new Error(
            `${kind}: "experimental_usePageTitle" must be a React hook function when set`
          );
        }
        const legacy = registration;
        const fixedTabs = [];
        if (legacy.fixedTabs !== void 0 && !Array.isArray(legacy.fixedTabs)) {
          onWarning("Legacy navPanel.fixedTabs ignored: expected an array");
        }
        for (const value of Array.isArray(legacy.fixedTabs) ? legacy.fixedTabs : []) {
          try {
            const id2 = requireSlotId(kind, value?.id);
            const tab = {
              id: id2,
              panelId,
              title: requireNonEmptyString(kind, "title", value.title ?? id2),
              icon: typeof value.icon === "string" ? value.icon : "",
              component: requireComponent(kind, value.component),
              ...value.layout === "flush" ? { layout: "flush" } : {},
              ...typeof value.experimental_target?.validate === "function" ? { experimental_target: value.experimental_target } : {}
            };
            collectTab(
              {
                ...tab,
                context: { kind: "nav-panel", panelId },
                availability: "fixed"
              },
              true
            );
            fixedTabs.push(tab);
          } catch (error) {
            onWarning(
              `Legacy navPanel.fixedTabs entry ignored: ${String(error)}`
            );
          }
        }
        collected.navPanels.push({
          id,
          title: requireNonEmptyString(kind, "title", registration.title),
          icon: requireNonEmptyString(kind, "icon", registration.icon),
          path,
          ...fixedTabs.length === 0 ? {} : { fixedTabs },
          component: requireComponent(kind, registration.component),
          ...registration.experimental_useBadge !== void 0 ? {
            experimental_useBadge: registration.experimental_useBadge
          } : {},
          ...registration.experimental_usePageTitle !== void 0 ? {
            experimental_usePageTitle: registration.experimental_usePageTitle
          } : {},
          ...registration.experimental_sidebar !== void 0 ? { experimental_sidebar: registration.experimental_sidebar } : {},
          ...registration.headerContent !== void 0 ? { headerContent: registration.headerContent } : {}
        });
      },
      experimental_tab(registration) {
        collectTab(registration);
      },
      experimental_newThreadPanelAction(registration) {
        collected.newThreadPanelActions.push(
          collectPanelAction(
            "slots.experimental_newThreadPanelAction",
            seenIds.newThreadPanelAction,
            registration
          )
        );
      },
      pendingInteraction(registration) {
        const kind = "slots.pendingInteraction";
        const id = requireSlotId(kind, registration?.id);
        requireUniqueId(kind, seenIds.pendingInteraction, id);
        collected.pendingInteractions.push({
          id,
          component: requireComponent(kind, registration.component)
        });
      },
      sidebarFooterAction(registration) {
        const kind = "slots.sidebarFooterAction";
        const id = requireSlotId(kind, registration?.id);
        requireUniqueId(kind, seenIds.sidebarFooterItem, id);
        if (typeof registration.run !== "function") {
          throw new Error(`${kind}: "run" must be a function`);
        }
        const legacyRegistration = {
          id,
          title: requireNonEmptyString(kind, "title", registration.title),
          icon: requireNonEmptyString(kind, "icon", registration.icon),
          run: registration.run
        };
        collected.sidebarFooterActions.push(legacyRegistration);
        sidebarFooterItems.push(adaptSidebarFooterAction(legacyRegistration));
      },
      experimental_threadList(registration) {
        collected.threadLists.push(
          collectTitledComponent(
            "slots.experimental_threadList",
            seenIds.threadList,
            registration
          )
        );
      },
      experimental_sidebarNavigation(registration) {
        const kind = "slots.experimental_sidebarNavigation";
        const collectedRegistration = collectTitledComponent(
          kind,
          seenIds.sidebarNavigation,
          registration
        );
        const placement = registration.placement;
        if (placement !== void 0 && placement !== "rail" && placement !== "list") {
          throw new Error(`${kind}: "placement" must be "rail" or "list"`);
        }
        const headerComponent = registration.headerComponent;
        if (headerComponent !== void 0 && typeof headerComponent !== "function") {
          throw new Error(
            `${kind}: "headerComponent" must be a React component function`
          );
        }
        collected.experimentalSidebarNavigations.push({
          ...collectedRegistration,
          placement: placement ?? "list",
          ...headerComponent !== void 0 ? { headerComponent } : {}
        });
      },
      experimental_threadContextSegment(registration) {
        const kind = "slots.experimental_threadContextSegment";
        const id = requireSlotId(kind, registration?.id);
        requireUniqueId(kind, seenIds.threadContextSegment, id);
        const optionalComponent = (field) => {
          const value = registration[field];
          if (value === void 0) return {};
          if (typeof value !== "function") {
            throw new Error(
              `${kind}: "${field}" must be a React component function`
            );
          }
          return { [field]: value };
        };
        if (typeof registration.summary !== "function") {
          throw new Error(
            `${kind}: "summary" must be a React component function`
          );
        }
        if (registration.useVisible !== void 0 && typeof registration.useVisible !== "function") {
          throw new Error(`${kind}: "useVisible" must be a function`);
        }
        collected.threadContextSegments.push({
          id,
          title: requireNonEmptyString(kind, "title", registration.title),
          group: requireNonEmptyString(kind, "group", registration.group),
          ...requireOptionalOrder(kind, registration.order),
          summary: registration.summary,
          ...optionalComponent("action"),
          ...optionalComponent("details"),
          ...registration.useVisible !== void 0 ? { useVisible: registration.useVisible } : {}
        });
      },
      experimental_threadRowMetadata(registration) {
        const kind = "slots.experimental_threadRowMetadata";
        const id = requireSlotId(kind, registration?.id);
        requireUniqueId(kind, seenIds.threadRowMetadata, id);
        if (registration.useData !== void 0 && typeof registration.useData !== "function")
          throw new Error(`${kind}: "useData" must be a function`);
        collected.threadRowMetadata.push({
          id,
          ...requireOptionalOrder(kind, registration.order),
          ...registration.useData !== void 0 ? { useData: registration.useData } : {},
          component: requireComponent(kind, registration.component)
        });
      },
      experimental_threadInfoRow(registration) {
        const kind = "slots.experimental_threadInfoRow";
        const id = requireSlotId(kind, registration?.id);
        requireUniqueId(kind, seenIds.threadInfoRow, id);
        collected.threadInfoRows.push({
          id,
          group: requireNonEmptyString(kind, "group", registration.group),
          ...requireOptionalOrder(kind, registration.order),
          component: requireComponent(kind, registration.component)
        });
      },
      experimental_threadInfoSection(registration) {
        const kind = "slots.experimental_threadInfoSection";
        const id = requireSlotId(kind, registration?.id);
        requireUniqueId(kind, seenIds.threadInfoSection, id);
        collected.threadInfoSections.push({
          id,
          group: requireNonEmptyString(kind, "group", registration.group),
          ...requireOptionalOrder(kind, registration.order),
          component: requireComponent(kind, registration.component)
        });
      },
      experimental_threadContextCardRow(registration) {
        const kind = "slots.experimental_threadContextCardRow";
        const id = requireSlotId(kind, registration?.id);
        requireUniqueId(kind, seenIds.threadContextCardRow, id);
        collected.threadContextCardRows.push({
          id,
          group: requireNonEmptyString(kind, "group", registration.group),
          ...requireOptionalOrder(kind, registration.order),
          component: requireComponent(kind, registration.component)
        });
      },
      experimental_threadContextCardSection(registration) {
        const kind = "slots.experimental_threadContextCardSection";
        const id = requireSlotId(kind, registration?.id);
        requireUniqueId(kind, seenIds.threadContextCardSection, id);
        collected.threadContextCardSections.push({
          id,
          title: requireNonEmptyString(kind, "title", registration.title),
          group: requireNonEmptyString(kind, "group", registration.group),
          ...requireOptionalOrder(kind, registration.order),
          component: requireComponent(kind, registration.component)
        });
      },
      experimental_threadAction(registration) {
        const kind = "slots.experimental_threadAction";
        const id = requireSlotId(kind, registration?.id);
        requireUniqueId(kind, seenIds.threadAction, id);
        if (typeof registration.item !== "function") {
          throw new Error(`${kind}: "item" must be a function`);
        }
        if (registration.useData !== void 0 && typeof registration.useData !== "function") {
          throw new Error(`${kind}: "useData" must be a function`);
        }
        if (registration.experimental_bulkItem !== void 0 && typeof registration.experimental_bulkItem !== "function") {
          throw new Error(
            `${kind}: "experimental_bulkItem" must be a function`
          );
        }
        if (registration.placement !== void 0 && registration.placement !== "menu" && registration.placement !== "header") {
          throw new Error(`${kind}: "placement" must be "menu" or "header"`);
        }
        collected.threadActions.push({
          id,
          title: requireNonEmptyString(kind, "title", registration.title),
          icon: requireNonEmptyString(kind, "icon", registration.icon),
          group: requireNonEmptyString(kind, "group", registration.group),
          ...requireOptionalOrder(kind, registration.order),
          ...registration.placement !== void 0 ? { placement: registration.placement } : {},
          ...registration.useData !== void 0 ? { useData: registration.useData } : {},
          item: registration.item,
          ...registration.experimental_bulkItem !== void 0 ? {
            experimental_bulkItem: registration.experimental_bulkItem
          } : {}
        });
      },
      experimental_browserToolbarAction(registration) {
        const kind = "slots.experimental_browserToolbarAction";
        const id = requireSlotId(kind, registration?.id);
        requireUniqueId(kind, seenIds.browserToolbarAction, id);
        collected.browserToolbarActions.push({
          id,
          title: requireNonEmptyString(kind, "title", registration.title),
          component: requireComponent(kind, registration.component)
        });
      },
      fileOpener(registration) {
        const kind = "slots.fileOpener";
        const id = requireSlotId(kind, registration?.id);
        requireUniqueId(kind, seenIds.fileOpener, id);
        const rawExtensions = registration?.extensions;
        if (!Array.isArray(rawExtensions)) {
          throw new Error(
            `${kind}: "extensions" must be an array of lowercase extensions without the dot`
          );
        }
        const extensions = rawExtensions.map((extension) => {
          if (typeof extension !== "string" || !/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(extension)) {
            throw new Error(
              `${kind}: extensions must be lowercase alphanumerics with single underscores or hyphens between segments, without the dot, got ${JSON.stringify(extension)}`
            );
          }
          return extension;
        });
        collected.fileOpeners.push({
          id,
          title: requireNonEmptyString(kind, "title", registration.title),
          extensions,
          component: requireComponent(kind, registration.component)
        });
      },
      experimental_sourceCodeRenderer(registration) {
        collected.sourceCodeRenderers.push(
          collectTitledComponent(
            "slots.experimental_sourceCodeRenderer",
            seenIds.sourceCodeRenderer,
            registration
          )
        );
      },
      experimental_diffRenderer(registration) {
        collected.diffRenderers.push(
          collectTitledComponent(
            "slots.experimental_diffRenderer",
            seenIds.diffRenderer,
            registration
          )
        );
      },
      experimental_composer(registration) {
        collected.composers.push(
          collectTitledComponent(
            "slots.experimental_composer",
            seenIds.composer,
            registration
          )
        );
      },
      messageDirective(registration) {
        const kind = "slots.messageDirective";
        const id = requireMessageDirectiveId(kind, registration?.id);
        requireUniqueId(kind, seenIds.messageDirective, id);
        collected.messageDirectives.push({
          id,
          component: requireComponent(kind, registration.component)
        });
      },
      experimental_codeFenceRenderer(registration) {
        const kind = "slots.experimental_codeFenceRenderer";
        const id = requireSlotId(kind, registration?.id);
        requireUniqueId(kind, seenIds.codeFenceRenderer, id);
        const rawLanguages = registration.languages;
        if (!Array.isArray(rawLanguages) || rawLanguages.length === 0) {
          throw new Error(
            `${kind}: "languages" must be a non-empty array of lowercase info-string languages`
          );
        }
        const languages = rawLanguages.map((language) => {
          if (typeof language !== "string" || !CODE_FENCE_LANGUAGE_PATTERN.test(language)) {
            throw new Error(
              `${kind}: languages must match ${CODE_FENCE_LANGUAGE_PATTERN}, got ${JSON.stringify(language)}`
            );
          }
          if (seenIds.codeFenceLanguage.has(language)) {
            throw new Error(`${kind}: duplicate language "${language}"`);
          }
          seenIds.codeFenceLanguage.add(language);
          return language;
        });
        collected.codeFenceRenderers.push({
          id,
          languages,
          component: requireComponent(kind, registration.component)
        });
      },
      messageAction(registration) {
        const kind = "slots.messageAction";
        const id = requireSlotId(kind, registration?.id);
        requireUniqueId(kind, seenIds.messageAction, id);
        if (typeof registration.run !== "function") {
          throw new Error(`${kind}: "run" must be a function`);
        }
        collected.messageActions.push({
          id,
          title: requireNonEmptyString(kind, "title", registration.title),
          ...registration.icon !== void 0 ? {
            icon: requireNonEmptyString(kind, "icon", registration.icon)
          } : {},
          run: registration.run
        });
      },
      experimental_messageMetadata(registration) {
        const kind = "slots.experimental_messageMetadata";
        const id = requireSlotId(kind, registration?.id);
        requireUniqueId(kind, seenIds.messageMetadata, id);
        const placement = registration.placement ?? "above";
        if (placement !== "above" && placement !== "actionRow") {
          throw new Error(
            `${kind}: "placement" must be "above" or "actionRow"`
          );
        }
        collected.messageMetadata.push({
          id,
          placement,
          component: requireComponent(kind, registration.component)
        });
      },
      commandPaletteAction(registration) {
        registerCommand(registration);
      },
      experimental_providerIcon(registration) {
        const kind = "slots.experimental_providerIcon";
        const providerId = requireProviderId(kind, registration?.providerId);
        const declaredKind = registration.providerKind;
        if (declaredKind !== void 0 && declaredKind !== "agent" && declaredKind !== "machine" && declaredKind !== "environment") {
          throw new Error(`${kind}: invalid providerKind`);
        }
        const providerKind = declaredKind ?? "all";
        requireUniqueId(
          kind,
          seenIds.providerIcon,
          `${providerKind}:${providerId}`
        );
        collected.providerIcons.push({
          providerKind,
          providerId,
          icon: requireComponent(kind, registration.icon)
        });
      },
      experimental_timelineRenderer(registration) {
        const kind = "slots.experimental_timelineRenderer";
        const itemKind = requireTimelineRendererKind(kind, registration?.kind);
        requireUniqueId(kind, seenIds.timelineRenderer, itemKind);
        collected.timelineRenderers.push({
          kind: itemKind,
          component: requireComponent(kind, registration.component)
        });
      },
      experimental_environmentProviderInputs(registration) {
        const kind = "slots.experimental_environmentProviderInputs";
        const environmentProviderId = requireEnvironmentProviderId(
          kind,
          registration?.environmentProviderId
        );
        requireUniqueId(
          kind,
          seenIds.environmentProviderInputs,
          environmentProviderId
        );
        collected.environmentProviderInputs.push({
          environmentProviderId,
          component: requireComponent(kind, registration.component)
        });
      },
      experimental_machineProviderInputs(registration) {
        const kind = "slots.experimental_machineProviderInputs";
        const machineProviderId = requireProviderId(
          kind,
          registration?.machineProviderId
        );
        requireUniqueId(kind, seenIds.machineProviderInputs, machineProviderId);
        collected.machineProviderInputs.push({
          machineProviderId,
          component: requireComponent(kind, registration.component)
        });
      }
    },
    experimental_sidebarFooter: new SidebarFooterCollector(
      collected.experimentalSidebarFooterItems,
      sidebarFooterItems,
      seenIds.sidebarFooterItem
    ),
    composer: {
      customize(registration) {
        const customization = collectComposerCustomization(
          registration,
          seenIds.composerCustomization,
          (reason) => onWarning(`composer customization rejected: ${reason}`),
          seenIds.composerPopup
        );
        if (customization !== null) {
          collected.composerCustomizations.push(customization);
        }
      },
      experimental_registerCommand: registerComposerCommand
    },
    experimental_threadDisplayPolicy(resolve) {
      if (typeof resolve !== "function") {
        throw new Error(
          "experimental_threadDisplayPolicy: resolver must be a function"
        );
      }
      collected.threadDisplayPolicies.push(resolve);
    },
    experimental_icons: {
      register(registration) {
        const kind = "experimental_icons.register";
        const name = requireNonEmptyString(
          kind,
          "name",
          registration?.name
        ).trim();
        if (name.length === 0)
          throw new Error(`${kind}: "name" must not be blank`);
        if (collected.icons.some((icon) => icon.name === name)) {
          throw new Error(`${kind}: duplicate icon name "${name}"`);
        }
        collected.icons.push({
          name,
          component: requireComponent(kind, registration.component)
        });
      }
    },
    contentScripts: {
      register(registration) {
        const kind = "contentScripts.register";
        const id = requireSlotId(kind, registration?.id);
        requireUniqueId(kind, seenIds.contentScript, id);
        if (typeof registration.mount !== "function") {
          throw new Error(`${kind}: "mount" must be a function`);
        }
        collected.contentScripts.push({ id, mount: registration.mount });
      }
    }
  });
  attachLegacySidebarHeaders(
    collected.experimentalSidebarNavigations,
    legacySidebarHeaders,
    onWarning
  );
  return collected;
}
function attachLegacySidebarHeaders(navigations, headers, onWarning) {
  const [header, ...extraHeaders] = headers;
  if (header === void 0) return;
  const kind = "slots.experimental_sidebarHeader";
  if (extraHeaders.length > 0) {
    onWarning(
      `${kind}: only the first header is used; pass "headerComponent" to each experimental_sidebarNavigation instead`
    );
  }
  let attached = false;
  navigations.forEach((navigation, index) => {
    if (navigation.headerComponent !== void 0) return;
    navigations[index] = { ...navigation, headerComponent: header };
    attached = true;
  });
  if (!attached) {
    onWarning(
      `${kind}: ignored because the plugin registers no navigation without a "headerComponent"`
    );
  }
}
export {
  adaptSidebarFooterAction,
  collectPluginAppRegistrations,
  getCollectedSidebarFooterItems,
  installModalDriver
};
