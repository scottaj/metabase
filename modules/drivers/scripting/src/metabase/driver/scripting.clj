(ns metabase.driver.scripting
  "Scripting Driver"
  (:require [metabase.driver :as driver])
  (:require [clojure.java.io :as io])
  (:import (java.nio.file FileSystems)))


(driver/register! :scripting)



(defn check-directory [details_map]
      (.isDirectory (io/file (details_map :script-directory))))

(defn check-executable-file [details_map]
      (.canExecute (io/file (details_map :interpreter))))


(defmethod driver/can-connect? :scripting [_ details_map]
  (and (boolean (check-directory details_map))
       (boolean (check-executable-file details_map))))

(defn list-scripts [details_map]
  (let [grammar-matcher (.getPathMatcher
                            (FileSystems/getDefault)
                            (str "glob:" (details_map :script-matcher)))]
    (->> (details_map :script-directory)
         io/file
         file-seq
         (filter #(.isFile %))
         (filter #(.matches grammar-matcher (.getFileName (.toPath %))))
         (mapv #(.getName %)))))

(defmethod driver/describe-database :scripting [_ database]
  {:tables (set (map #(hash-map :name % :schema nil) (list-scripts (:details database))))})

;(defmethod driver/describe-table
;  [_ details_map table])
